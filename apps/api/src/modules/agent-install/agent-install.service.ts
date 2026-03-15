/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements agent install service business logic for the service layer.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  AgentInstallApprove,
  AgentInstallDeny,
  AgentInstallStatus,
  CreateAgentInstallRequest,
  LaunchAgentInstallRequest,
  AgentInstallUninstallFromAgent,
} from '@homelab/shared';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filter, map, type Observable, Subject } from 'rxjs';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../../prisma/prisma.service';

type InstallSecret = {
  authMode: 'KEY' | 'PASSWORD';
  sshPrivateKey?: string;
  sshPassword?: string;
  sudoPassword?: string;
};

type InstallStreamEvent = {
  requestId: string;
  type: 'log' | 'status';
  payload: Record<string, unknown>;
};

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

type SeqState = {
  next: number;
};

type RunCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type SshRuntime = {
  target: string;
  port: number;
  sshArgs: string[];
  scpArgs: string[];
  authMode: 'KEY' | 'PASSWORD';
  env: NodeJS.ProcessEnv;
  keyFilePath?: string;
};

type InstallRequestRecord = {
  id: string;
  action: AgentInstallAction;
  status: DbAgentInstallStatus;
  requestedByUserId: string;
  approvedByUserId: string | null;
  deniedByUserId: string | null;
  targetHostId: string | null;
  targetHost: string;
  targetPort: number;
  targetUsername: string;
  authMode: string;
  binaryVersion: string;
  binaryUrlResolved: string | null;
  controlPlaneUrl: string;
  mcpBind: string;
  mcpPort: number;
  mcpAdvertiseUrl: string;
  allowedOrigins: string;
  allowInsecureDev: boolean;
  replaceExisting: boolean;
  installPath: string;
  serviceName: string;
  rollbackOfRequestId: string | null;
  resultCode: string | null;
  resultSummary: string | null;
  errorMessageSanitized: string | null;
  agentIdLinked: string | null;
  approvedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  deniedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  logs?: Array<{
    id: string;
    seq: number;
    phase: string;
    level: string;
    message: string;
    createdAt: Date;
  }>;
};

const maxStoredOutputChars = 40_000;
const defaultBinaryVersion = 'v0.2.0';
const defaultBinaryStoreRoot = '/opt/homelab-agent-binaries';

type AgentInstallAction = 'INSTALL' | 'ROLLBACK';
type DbAgentInstallStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED_AWAITING_EXECUTION'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DENIED';

const agentInstallActionValues = {
  INSTALL: 'INSTALL' as AgentInstallAction,
  ROLLBACK: 'ROLLBACK' as AgentInstallAction,
};

const dbAgentInstallStatusValues = {
  PENDING_APPROVAL: 'PENDING_APPROVAL' as DbAgentInstallStatus,
  APPROVED_AWAITING_EXECUTION: 'APPROVED_AWAITING_EXECUTION' as DbAgentInstallStatus,
  RUNNING: 'RUNNING' as DbAgentInstallStatus,
  SUCCEEDED: 'SUCCEEDED' as DbAgentInstallStatus,
  FAILED: 'FAILED' as DbAgentInstallStatus,
  DENIED: 'DENIED' as DbAgentInstallStatus,
};

@Injectable()
/**
 * Implements the agent install service class.
 */
export class AgentInstallService implements OnModuleInit, OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly queueName: string;
  private readonly secretTtlMs: number;

  private queue: Queue | null = null;
  private worker: Worker | null = null;

  private readonly secretVault = new Map<string, InstallSecret>();
  private readonly secretTimers = new Map<string, NodeJS.Timeout>();
  private readonly stream$ = new Subject<InstallStreamEvent>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly agentsService: AgentsService,
    private readonly auditService: AuditService,
    private readonly eventsService: EventsService,
  ) {
    this.enabled = this.configService.get<boolean>('AGENT_INSTALL_ENABLED', false);
    this.queueName = this.configService.get<string>(
      'AGENT_INSTALL_QUEUE_NAME',
      'agent-install-jobs',
    );
    this.secretTtlMs = this.configService.get<number>('AGENT_INSTALL_SECRET_TTL_SEC', 900) * 1000;
  }

  /**
   * Handles on module init.
   */
  async onModuleInit() {
    if (!this.enabled) {
      return;
    }

    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      throw new Error('REDIS_URL is required for agent install queue');
    }

    const connection = { url: redisUrl };
    this.queue = new Queue(this.queueName, { connection });

    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        if (job.name !== 'agent-install.execute') {
          return { ok: false, skipped: true };
        }
        const requestIdRaw = (job.data as { requestId?: unknown }).requestId;
        const requestId = typeof requestIdRaw === 'string' ? requestIdRaw : '';
        if (!requestId) {
          throw new Error('requestId is required');
        }
        await this.processInstallJob(requestId);
        return { ok: true, requestId };
      },
      {
        connection,
        concurrency: 2,
      },
    );

    this.worker.on('failed', async (job, error) => {
      const requestIdRaw = (job?.data as { requestId?: unknown } | undefined)?.requestId;
      const requestId = typeof requestIdRaw === 'string' ? requestIdRaw : null;
      if (!requestId) {
        return;
      }
      await this.markRequestFailed(requestId, `Queue worker failed: ${error.message}`);
    });
  }

  /**
   * Handles on module destroy.
   */
  async onModuleDestroy() {
    for (const timer of this.secretTimers.values()) {
      clearTimeout(timer);
    }
    this.secretTimers.clear();
    this.secretVault.clear();

    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }

  /**
   * Implements the stream request workflow for this file.
   */
  streamRequest(requestId: string): Observable<{ data: Record<string, unknown> }> {
    return this.stream$.pipe(
      filter((event) => event.requestId === requestId),
      map((event) => {
        return {
          data: {
            requestId: event.requestId,
            type: event.type,
            ...event.payload,
          },
        };
      }),
    );
  }

  /**
   * Handles binary manifest.
   */
  async binaryManifest() {
    const configuredDefaultVersion = this.configService.get<string>(
      'AGENT_BINARY_DEFAULT_VERSION',
      defaultBinaryVersion,
    );
    const defaultVersion = isSafeBinaryVersion(configuredDefaultVersion)
      ? configuredDefaultVersion
      : defaultBinaryVersion;
    const storeRoot = this.getBinaryStoreRoot();
    const binaries = await this.collectBinaryManifestEntries(defaultVersion);

    return {
      enabled: this.enabled,
      source: 'CONTAINER_STORE' as const,
      storeRootConfigured: storeRoot.length > 0,
      defaultVersion,
      binaries,
    };
  }

  /**
   * Creates request.
   */
  async createRequest(userId: string, body: CreateAgentInstallRequest) {
    this.ensureEnabled();
    this.validateCreateRequest(body);

    if (body.action === 'ROLLBACK' && !body.rollbackOfRequestId) {
      throw new BadRequestException('rollbackOfRequestId is required for rollback requests');
    }

    if (body.targetHostId) {
      const host = await this.prisma.host.findUnique({ where: { id: body.targetHostId } });
      if (!host) {
        throw new NotFoundException('Target host not found');
      }
    }

    const created = await this.prisma.agentInstallRequest.create({
      data: {
        action: body.action,
        status: dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION,
        requestedByUserId: userId,
        approvedByUserId: userId,
        approvedAt: new Date(),
        deniedByUserId: null,
        deniedAt: null,
        targetHostId: body.targetHostId,
        targetHost: body.targetHost.trim(),
        targetPort: body.targetPort,
        targetUsername: body.targetUsername.trim(),
        authMode: body.authMode,
        binaryVersion: body.binaryVersion.trim(),
        controlPlaneUrl: body.controlPlaneUrl,
        mcpBind: body.mcpBind,
        mcpPort: body.mcpPort,
        mcpAdvertiseUrl: body.mcpAdvertiseUrl,
        allowedOrigins: body.allowedOrigins,
        allowInsecureDev: body.allowInsecureDev,
        replaceExisting: body.replaceExisting,
        installPath: body.installPath,
        serviceName: body.serviceName,
        rollbackOfRequestId: body.rollbackOfRequestId,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.request_create',
      targetType: 'agent_install_request',
      targetId: created.id,
      paramsJson: {
        action: created.action,
        targetHost: created.targetHost,
        targetPort: created.targetPort,
        targetUsername: created.targetUsername,
      },
      success: true,
    });

    await this.eventsService.emit({
      type: 'agent_install.request_created',
      message: `Agent install request queued for ${created.targetHost}`,
      hostId: created.targetHostId ?? undefined,
      payload: {
        requestId: created.id,
        action: created.action,
      },
    });

    return this.serializeRequest(created);
  }

  /**
   * Handles list requests.
   */
  async listRequests(status?: AgentInstallStatus) {
    const where = status ? { status: status as DbAgentInstallStatus } : undefined;
    const requests = await this.prisma.agentInstallRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return {
      requests: requests.map((request) => this.serializeRequest(request)),
    };
  }

  /**
   * Gets request.
   */
  async getRequest(requestId: string) {
    const request = await this.prisma.agentInstallRequest.findUnique({
      where: { id: requestId },
      include: {
        logs: {
          orderBy: { seq: 'asc' },
          take: 1000,
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Install request not found');
    }

    return this.serializeRequest(request);
  }

  /**
   * Handles list logs.
   */
  async listLogs(requestId: string, limit: number | undefined = 400) {
    const request = await this.prisma.agentInstallRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (!request) {
      throw new NotFoundException('Install request not found');
    }

    const boundedLimit = normalizeIntLimit(limit, 400, 1, 2_000);
    const logs = await this.prisma.agentInstallLog.findMany({
      where: { requestId },
      orderBy: { seq: 'asc' },
      take: boundedLimit,
    });

    return {
      requestId,
      logs: logs.map((log) => ({
        id: log.id,
        seq: log.seq,
        phase: log.phase,
        level: log.level,
        message: log.message,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Handles approve request.
   */
  async approveRequest(requestId: string, userId: string, body: AgentInstallApprove) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Approval confirmation is required');
    }

    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Install request not found');
    }
    if (request.status !== dbAgentInstallStatusValues.PENDING_APPROVAL) {
      throw new ConflictException('Only pending requests can be approved');
    }

    const updated = await this.prisma.agentInstallRequest.update({
      where: { id: requestId },
      data: {
        status: dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION,
        approvedByUserId: userId,
        approvedAt: new Date(),
        deniedByUserId: null,
        deniedAt: null,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.request_approve',
      targetType: 'agent_install_request',
      targetId: requestId,
      success: true,
    });

    this.publishStatus(updated);
    return this.serializeRequest(updated);
  }

  /**
   * Handles deny request.
   */
  async denyRequest(requestId: string, userId: string, body: AgentInstallDeny) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Deny confirmation is required');
    }

    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Install request not found');
    }
    if (request.status !== dbAgentInstallStatusValues.PENDING_APPROVAL) {
      throw new ConflictException('Only pending requests can be denied');
    }

    const reason = body.reason?.trim() || 'Denied by approver';
    const updated = await this.prisma.agentInstallRequest.update({
      where: { id: requestId },
      data: {
        status: dbAgentInstallStatusValues.DENIED,
        deniedByUserId: userId,
        deniedAt: new Date(),
        errorMessageSanitized: reason,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.request_deny',
      targetType: 'agent_install_request',
      targetId: requestId,
      paramsJson: { reason },
      success: true,
    });

    await this.appendLog(requestId, 'approval', 'WARN', reason);
    this.publishStatus(updated);
    return this.serializeRequest(updated);
  }

  /**
   * Checks whether cancel request.
   */
  async cancelRequest(requestId: string, userId: string, body: AgentInstallApprove) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Cancel confirmation is required');
    }

    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Install request not found');
    }
    if (request.status === dbAgentInstallStatusValues.RUNNING) {
      throw new ConflictException('Cannot cancel a running request');
    }
    if (
      request.status !== dbAgentInstallStatusValues.PENDING_APPROVAL &&
      request.status !== dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION
    ) {
      throw new ConflictException('Only queued requests can be canceled');
    }

    const reason = 'Canceled by user';
    const updated = await this.prisma.agentInstallRequest.update({
      where: { id: requestId },
      data: {
        status: dbAgentInstallStatusValues.DENIED,
        deniedByUserId: userId,
        deniedAt: new Date(),
        approvedByUserId: null,
        approvedAt: null,
        errorMessageSanitized: reason,
      },
    });

    this.secretVault.delete(requestId);
    const timer = this.secretTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.secretTimers.delete(requestId);
    }

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.request_cancel',
      targetType: 'agent_install_request',
      targetId: requestId,
      success: true,
    });

    await this.appendLog(requestId, 'queue', 'WARN', reason);
    this.publishStatus(updated);
    return this.serializeRequest(updated);
  }

  /**
   * Handles delete request.
   */
  async deleteRequest(requestId: string, userId: string, body: AgentInstallApprove) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Delete confirmation is required');
    }

    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Install request not found');
    }

    if (
      request.status !== dbAgentInstallStatusValues.FAILED &&
      request.status !== dbAgentInstallStatusValues.SUCCEEDED &&
      request.status !== dbAgentInstallStatusValues.DENIED
    ) {
      throw new ConflictException('Only failed or completed requests can be deleted');
    }

    this.secretVault.delete(requestId);
    const timer = this.secretTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.secretTimers.delete(requestId);
    }

    await this.prisma.agentInstallRequest.delete({
      where: { id: requestId },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.request_delete',
      targetType: 'agent_install_request',
      targetId: requestId,
      resultJson: {
        previousStatus: request.status,
      },
      success: true,
    });

    await this.eventsService.emit({
      type: 'agent_install.request_deleted',
      message: `Agent install request deleted for ${request.targetHost}`,
      hostId: request.targetHostId ?? undefined,
      payload: {
        requestId,
      },
    });

    return {
      ok: true,
      deleted: true,
      requestId,
    };
  }

  /**
   * Handles launch request.
   */
  async launchRequest(requestId: string, userId: string, body: LaunchAgentInstallRequest) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Launch confirmation is required');
    }

    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException('Install request not found');
    }

    if (request.status !== dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION) {
      if (
        request.status === dbAgentInstallStatusValues.RUNNING ||
        request.status === dbAgentInstallStatusValues.SUCCEEDED
      ) {
        await this.auditService.write({
          actorUserId: userId,
          action: 'agent_install.launch_noop',
          targetType: 'agent_install_request',
          targetId: requestId,
          resultJson: {
            status: request.status,
            reason: 'already_launched',
          },
          success: true,
        });

        return {
          ok: true,
          queued: false,
          requestId,
          alreadyLaunched: true,
          currentStatus: request.status as AgentInstallStatus,
        };
      }

      throw new ConflictException(`Request is not launchable from status ${request.status}`);
    }

    if (request.authMode !== body.authMode) {
      throw new BadRequestException('Launch authMode must match request authMode');
    }

    this.storeSecret(requestId, {
      authMode: body.authMode,
      sshPrivateKey: body.sshPrivateKey,
      sshPassword: body.sshPassword,
      sudoPassword: body.sudoPassword,
    });

    if (!this.queue) {
      throw new ConflictException('Install queue is not available');
    }

    await this.queue.add(
      'agent-install.execute',
      {
        requestId,
      },
      {
        jobId: `agent-install:${requestId}:${randomUUID()}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.launch',
      targetType: 'agent_install_request',
      targetId: requestId,
      paramsJson: {
        authMode: body.authMode,
      },
      success: true,
    });

    await this.appendLog(requestId, 'queue', 'INFO', 'Execution queued.');
    return {
      ok: true,
      queued: true,
      requestId,
    };
  }

  /**
   * Creates rollback request.
   */
  async createRollbackRequest(requestId: string, userId: string, body: AgentInstallApprove) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Rollback confirmation is required');
    }

    const source = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!source) {
      throw new NotFoundException('Install request not found');
    }

    if (source.action !== agentInstallActionValues.INSTALL) {
      throw new ConflictException('Rollback can only be created for install requests');
    }

    if (
      source.status !== dbAgentInstallStatusValues.FAILED &&
      source.status !== dbAgentInstallStatusValues.SUCCEEDED
    ) {
      throw new ConflictException('Rollback can only be created for completed requests');
    }

    const created = await this.prisma.agentInstallRequest.create({
      data: {
        action: agentInstallActionValues.ROLLBACK,
        status: dbAgentInstallStatusValues.PENDING_APPROVAL,
        requestedByUserId: userId,
        targetHostId: source.targetHostId,
        targetHost: source.targetHost,
        targetPort: source.targetPort,
        targetUsername: source.targetUsername,
        authMode: source.authMode,
        binaryVersion: source.binaryVersion,
        controlPlaneUrl: source.controlPlaneUrl,
        mcpBind: source.mcpBind,
        mcpPort: source.mcpPort,
        mcpAdvertiseUrl: source.mcpAdvertiseUrl,
        allowedOrigins: source.allowedOrigins,
        allowInsecureDev: source.allowInsecureDev,
        replaceExisting: source.replaceExisting,
        agentIdLinked: source.agentIdLinked,
        installPath: source.installPath,
        serviceName: source.serviceName,
        rollbackOfRequestId: source.id,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.rollback_create',
      targetType: 'agent_install_request',
      targetId: created.id,
      paramsJson: {
        rollbackOfRequestId: source.id,
      },
      success: true,
    });

    return this.serializeRequest(created);
  }

  async createUninstallRequestFromAgent(
    agentId: string,
    userId: string,
    body: AgentInstallUninstallFromAgent,
  ) {
    this.ensureEnabled();
    if (body.confirm !== true) {
      throw new BadRequestException('Uninstall confirmation is required');
    }

    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        host: {
          select: {
            tags: true,
          },
        },
      },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (agent.revokedAt) {
      throw new ConflictException('Cannot create uninstall request for revoked agent');
    }

    const source = await this.prisma.agentInstallRequest.findFirst({
      where: {
        action: agentInstallActionValues.INSTALL,
        status: dbAgentInstallStatusValues.SUCCEEDED,
        agentIdLinked: agentId,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!source) {
      throw new NotFoundException('No successful install request found for this agent');
    }

    const activeUninstallRequest = await this.prisma.agentInstallRequest.findFirst({
      where: {
        action: agentInstallActionValues.ROLLBACK,
        status: {
          in: [
            dbAgentInstallStatusValues.PENDING_APPROVAL,
            dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION,
            dbAgentInstallStatusValues.RUNNING,
          ],
        },
        OR: [{ rollbackOfRequestId: source.id }, { agentIdLinked: agentId }],
      },
    });
    if (activeUninstallRequest) {
      throw new ConflictException('An uninstall request for this agent is already in progress.');
    }

    const created = await this.prisma.agentInstallRequest.create({
      data: {
        action: agentInstallActionValues.ROLLBACK,
        status: dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION,
        requestedByUserId: userId,
        approvedByUserId: userId,
        approvedAt: new Date(),
        deniedByUserId: null,
        deniedAt: null,
        agentIdLinked: agentId,
        targetHostId: source.targetHostId,
        targetHost: source.targetHost,
        targetPort: source.targetPort,
        targetUsername: source.targetUsername,
        authMode: source.authMode,
        binaryVersion: source.binaryVersion,
        controlPlaneUrl: source.controlPlaneUrl,
        mcpBind: source.mcpBind,
        mcpPort: source.mcpPort,
        mcpAdvertiseUrl: source.mcpAdvertiseUrl,
        allowedOrigins: source.allowedOrigins,
        allowInsecureDev: source.allowInsecureDev,
        replaceExisting: source.replaceExisting,
        installPath: source.installPath,
        serviceName: source.serviceName,
        rollbackOfRequestId: source.id,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'agent_install.uninstall_request_create',
      targetType: 'agent_install_request',
      targetId: created.id,
      paramsJson: {
        agentId,
        sourceRequestId: source.id,
      },
      success: true,
    });

    await this.eventsService.emit({
      type: 'agent_install.uninstall_request_created',
      message: `Agent uninstall request created for ${source.targetHost}`,
      hostId: created.targetHostId ?? undefined,
      payload: {
        requestId: created.id,
        agentId,
        sourceRequestId: source.id,
      },
    });

    return this.serializeRequest(created);
  }

  /**
   * Handles ensure enabled.
   */
  private ensureEnabled() {
    if (!this.enabled) {
      throw new ForbiddenException('Agent install feature is disabled');
    }
  }

  /**
   * Handles validate create request.
   */
  private validateCreateRequest(body: CreateAgentInstallRequest) {
    if (!isSafeHostToken(body.targetHost)) {
      throw new BadRequestException('Invalid targetHost');
    }
    if (!isSafeUsername(body.targetUsername)) {
      throw new BadRequestException('Invalid targetUsername');
    }
    if (!isSafeBinaryVersion(body.binaryVersion)) {
      throw new BadRequestException('Invalid binaryVersion');
    }
    if (!isSafeServiceName(body.serviceName)) {
      throw new BadRequestException('Invalid serviceName');
    }
    if (!isSafeAbsolutePath(body.installPath)) {
      throw new BadRequestException('Invalid installPath');
    }
  }

  /**
   * Handles store secret.
   */
  private storeSecret(requestId: string, secret: InstallSecret) {
    this.secretVault.set(requestId, secret);

    const existingTimer = this.secretTimers.get(requestId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.secretVault.delete(requestId);
      this.secretTimers.delete(requestId);
    }, this.secretTtlMs);
    this.secretTimers.set(requestId, timer);
  }

  /**
   * Implements the consume secret workflow for this file.
   */
  private consumeSecret(requestId: string): InstallSecret | null {
    const secret = this.secretVault.get(requestId) ?? null;
    this.secretVault.delete(requestId);

    const timer = this.secretTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.secretTimers.delete(requestId);
    }

    return secret;
  }

  /**
   * Handles process install job.
   */
  private async processInstallJob(requestId: string) {
    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      return;
    }

    if (request.status !== dbAgentInstallStatusValues.APPROVED_AWAITING_EXECUTION) {
      return;
    }

    const secret = this.consumeSecret(requestId);
    if (!secret) {
      await this.markRequestFailed(requestId, 'Launch secret expired. Re-launch the request.');
      return;
    }

    const seqState = { next: await this.nextLogSeq(requestId) };
    const secretsForRedaction = [secret.sshPrivateKey, secret.sshPassword, secret.sudoPassword];

    await this.prisma.agentInstallRequest.update({
      where: { id: requestId },
      data: {
        status: dbAgentInstallStatusValues.RUNNING,
        startedAt: new Date(),
        finishedAt: null,
        errorMessageSanitized: null,
      },
    });
    this.publishStatusFromId(requestId).catch(() => undefined);

    await this.appendLog(
      requestId,
      'start',
      'INFO',
      `Starting ${request.action.toLowerCase()} workflow...`,
      seqState,
    );

    let runtime: SshRuntime | null = null;
    let remoteWorkDir = '';

    try {
      runtime = await this.prepareSshRuntime(request, secret);
      await this.appendLog(requestId, 'ssh', 'INFO', 'SSH client prepared.', seqState);

      remoteWorkDir = `/tmp/homelab-agent-install-${request.id.slice(0, 8)}-${Date.now()}`;
      await this.runRemoteCommand(runtime, `mkdir -p ${shellEscape(remoteWorkDir)}`, {
        requestId,
        phase: 'prepare',
        seqState,
        secrets: secretsForRedaction,
        label: 'Create remote temp directory',
      });

      const localInstallerPath = await this.resolveInstallerScriptPath();

      const remoteInstallerPath = `${remoteWorkDir}/install-labagent.sh`;
      await this.uploadFile(runtime, localInstallerPath, remoteInstallerPath, {
        requestId,
        phase: 'prepare',
        seqState,
        secrets: secretsForRedaction,
        label: 'Upload installer script',
      });
      await this.runRemoteCommand(runtime, `chmod +x ${shellEscape(remoteInstallerPath)}`, {
        requestId,
        phase: 'prepare',
        seqState,
        secrets: secretsForRedaction,
        label: 'Make installer executable',
      });

      if (request.action === agentInstallActionValues.INSTALL) {
        const actorUserId = request.approvedByUserId ?? request.requestedByUserId;
        const osResult = await this.runRemoteCommand(runtime, 'uname -s', {
          requestId,
          phase: 'probe',
          seqState,
          secrets: secretsForRedaction,
          label: 'Detect remote OS',
        });
        const normalizedOs = firstNonEmptyLine(osResult.stdout).toLowerCase();
        if (normalizedOs !== 'linux') {
          throw new Error(`Unsupported remote OS: ${normalizedOs || 'unknown'}`);
        }

        const archResult = await this.runRemoteCommand(runtime, 'uname -m', {
          requestId,
          phase: 'probe',
          seqState,
          secrets: secretsForRedaction,
          label: 'Detect remote architecture',
        });
        const platform = mapArchToPlatform(firstNonEmptyLine(archResult.stdout));
        if (!platform) {
          throw new Error(
            `Unsupported remote architecture: ${firstNonEmptyLine(archResult.stdout) || 'unknown'}`,
          );
        }

        const localBinaryPath = await this.resolveLocalBinaryPath(request.binaryVersion, platform);
        const remoteBinaryPath = `${remoteWorkDir}/labagent`;
        await this.appendLog(
          requestId,
          'install',
          'INFO',
          `Using control-plane binary version ${request.binaryVersion} (${platform}).`,
          seqState,
        );
        await this.appendLog(
          requestId,
          'install',
          'INFO',
          `Applying control plane URL to remote install: ${request.controlPlaneUrl}`,
          seqState,
        );
        await this.uploadFile(runtime, localBinaryPath, remoteBinaryPath, {
          requestId,
          phase: 'install',
          seqState,
          secrets: secretsForRedaction,
          label: 'Upload agent binary from control plane',
        });

        await this.runRemoteCommand(runtime, `chmod +x ${shellEscape(remoteBinaryPath)}`, {
          requestId,
          phase: 'install',
          seqState,
          secrets: secretsForRedaction,
          label: 'Make agent binary executable',
        });

        const enrollmentToken = await this.agentsService.createEnrollmentToken(actorUserId, 1);

        await this.appendLog(
          requestId,
          'install',
          'INFO',
          `Enrollment token issued with expiry ${enrollmentToken.expiresAt.toISOString()}.`,
          seqState,
        );

        const installCommand = this.buildInstallCommand({
          remoteInstallerPath,
          remoteBinaryPath,
          request,
          enrollmentToken: enrollmentToken.token,
          sudoPassword: secret.sudoPassword,
        });
        const runRuntime = runtime;
        if (!runRuntime) {
          throw new Error('SSH runtime unavailable before installer execution');
        }
        let enrollmentTokenCleanupWarning: string | null = null;
        const installResult = await (async () => {
          try {
            return await this.runRemoteCommand(runRuntime, installCommand, {
              requestId,
              phase: 'install',
              seqState,
              secrets: [...secretsForRedaction, enrollmentToken.token],
              label: 'Run installer',
              maxOutputLength: 120_000,
            });
          } finally {
            enrollmentTokenCleanupWarning = await this.revokeEnrollmentTokenSafe(
              enrollmentToken.tokenId,
              actorUserId,
            );
            if (enrollmentTokenCleanupWarning) {
              await this.appendLog(
                requestId,
                'install',
                'WARN',
                `Enrollment token cleanup warning: ${enrollmentTokenCleanupWarning}`,
                seqState,
              );
            } else {
              await this.appendLog(
                requestId,
                'install',
                'INFO',
                `Enrollment token ${enrollmentToken.tokenId} revoked after install execution.`,
                seqState,
              );
            }
          }
        })();

        const agentId = parseAgentId(installResult.stdout + '\n' + installResult.stderr);

        const updated = await this.prisma.agentInstallRequest.update({
          where: { id: request.id },
          data: {
            status: dbAgentInstallStatusValues.SUCCEEDED,
            finishedAt: new Date(),
            resultCode: 'ok',
            resultSummary: enrollmentTokenCleanupWarning
              ? 'Agent install completed with token cleanup warning.'
              : 'Agent install completed successfully.',
            errorMessageSanitized: null,
            agentIdLinked: agentId ?? null,
          },
        });

        await this.auditService.write({
          actorUserId,
          action: 'agent_install.execute',
          targetType: 'agent_install_request',
          targetId: request.id,
          resultJson: {
            status: 'SUCCEEDED',
            action: request.action,
            agentId,
            enrollmentTokenCleanupWarning,
          },
          success: true,
        });

        await this.eventsService.emit({
          type: 'agent_install.succeeded',
          message: `Agent install succeeded on ${request.targetHost}`,
          hostId: request.targetHostId ?? undefined,
          payload: {
            requestId: request.id,
            agentId,
          },
        });

        this.publishStatus(updated);
      } else {
        const rollbackCommand = this.buildRollbackCommand({
          remoteInstallerPath,
          request,
          sudoPassword: secret.sudoPassword,
        });

        await this.runRemoteCommand(runtime, rollbackCommand, {
          requestId,
          phase: 'rollback',
          seqState,
          secrets: secretsForRedaction,
          label: 'Run rollback uninstall',
          maxOutputLength: 120_000,
        });

        let revokeWarning: string | null = null;
        if (request.agentIdLinked) {
          revokeWarning = await this.revokeLinkedAgentSafe(
            request.agentIdLinked,
            request.approvedByUserId ?? request.requestedByUserId,
          );
        }

        const updated = await this.prisma.agentInstallRequest.update({
          where: { id: request.id },
          data: {
            status: dbAgentInstallStatusValues.SUCCEEDED,
            finishedAt: new Date(),
            resultCode: 'ok',
            resultSummary: revokeWarning
              ? 'Rollback completed with warnings.'
              : 'Rollback completed successfully.',
            errorMessageSanitized: null,
          },
        });

        if (revokeWarning) {
          await this.appendLog(
            requestId,
            'rollback',
            'WARN',
            `Uninstall completed with warning: ${revokeWarning}`,
            seqState,
          );
        }

        await this.auditService.write({
          actorUserId: request.approvedByUserId ?? request.requestedByUserId,
          action: 'agent_install.rollback_execute',
          targetType: 'agent_install_request',
          targetId: request.id,
          resultJson: {
            status: 'SUCCEEDED',
            revokeWarning,
          },
          success: true,
        });

        await this.eventsService.emit({
          type: 'agent_install.rollback_succeeded',
          message: `Agent rollback succeeded on ${request.targetHost}`,
          hostId: request.targetHostId ?? undefined,
          payload: {
            requestId: request.id,
          },
        });

        this.publishStatus(updated);
      }
    } catch (error) {
      const message = sanitizeText(
        error instanceof Error ? error.message : 'Unknown execution failure',
        [],
      );
      await this.markRequestFailed(requestId, message, seqState);

      await this.auditService.write({
        actorUserId: request.approvedByUserId ?? request.requestedByUserId,
        action:
          request.action === agentInstallActionValues.ROLLBACK
            ? 'agent_install.rollback_execute'
            : 'agent_install.execute',
        targetType: 'agent_install_request',
        targetId: request.id,
        resultJson: {
          status: 'FAILED',
          error: message,
        },
        success: false,
      });
    } finally {
      if (runtime && remoteWorkDir) {
        try {
          await this.runRemoteCommand(runtime, `rm -rf ${shellEscape(remoteWorkDir)}`, {
            requestId,
            phase: 'cleanup',
            seqState,
            secrets: secretsForRedaction,
            label: 'Cleanup remote temp directory',
            allowFailure: true,
          });
        } catch {
          // Best effort cleanup only.
        }
      }
      if (runtime) {
        await this.cleanupSshRuntime(runtime);
      }
    }
  }

  /**
   * Handles mark request failed.
   */
  private async markRequestFailed(requestId: string, message: string, seqState?: SeqState) {
    const sanitized = sanitizeText(message, []);
    const updated = await this.prisma.agentInstallRequest.update({
      where: { id: requestId },
      data: {
        status: dbAgentInstallStatusValues.FAILED,
        finishedAt: new Date(),
        resultCode: 'error',
        errorMessageSanitized: sanitized,
      },
    });

    await this.appendLog(requestId, 'error', 'ERROR', sanitized, seqState);
    this.publishStatus(updated);
  }

  private async prepareSshRuntime(
    request: {
      targetHost: string;
      targetPort: number;
      targetUsername: string;
    },
    secret: InstallSecret,
  ): Promise<SshRuntime> {
    await this.assertCommandAvailable('ssh');
    await this.assertCommandAvailable('scp');

    const runtime: SshRuntime = {
      target: `${request.targetUsername}@${request.targetHost}`,
      port: request.targetPort,
      sshArgs: [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'ConnectTimeout=15',
        '-p',
        String(request.targetPort),
      ],
      scpArgs: [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-P',
        String(request.targetPort),
      ],
      authMode: secret.authMode,
      env: {},
    };

    if (secret.authMode === 'KEY') {
      const key = secret.sshPrivateKey?.trim();
      if (!key) {
        throw new Error('Missing SSH private key for KEY auth mode');
      }
      const keyPath = path.join(tmpdir(), `homelab-agent-key-${randomUUID()}`);
      await fs.writeFile(keyPath, key, { mode: 0o600 });
      runtime.keyFilePath = keyPath;
      runtime.sshArgs.push('-i', keyPath);
      runtime.scpArgs.push('-i', keyPath);
      return runtime;
    }

    if (secret.authMode === 'PASSWORD') {
      const password = secret.sshPassword?.trim();
      if (!password) {
        throw new Error('Missing SSH password for PASSWORD auth mode');
      }
      runtime.env = {
        SSHPASS: password,
      };
      await this.assertCommandAvailable('sshpass');
      return runtime;
    }

    throw new Error('Unsupported SSH auth mode');
  }

  /**
   * Handles cleanup ssh runtime.
   */
  private async cleanupSshRuntime(runtime: SshRuntime) {
    if (runtime.keyFilePath) {
      try {
        await fs.unlink(runtime.keyFilePath);
      } catch {
        // Best effort cleanup.
      }
    }
  }

  /**
   * Handles assert command available.
   */
  private async assertCommandAvailable(command: string) {
    try {
      const result = await this.runLocalCommand('sh', [
        '-lc',
        `command -v ${shellEscape(command)}`,
      ]);
      if (result.code === 0) {
        return;
      }
    } catch {
      // Handled below.
    }
    throw new Error(`Missing required command on server: ${command}`);
  }

  private async uploadFile(
    runtime: SshRuntime,
    localPath: string,
    remotePath: string,
    options: {
      requestId: string;
      phase: string;
      seqState: SeqState;
      secrets: Array<string | undefined>;
      label: string;
    },
  ) {
    await this.appendLog(
      options.requestId,
      options.phase,
      'INFO',
      `${options.label}...`,
      options.seqState,
    );

    const args =
      runtime.authMode === 'PASSWORD'
        ? ['-e', 'scp', ...runtime.scpArgs, localPath, `${runtime.target}:${remotePath}`]
        : [...runtime.scpArgs, localPath, `${runtime.target}:${remotePath}`];
    const command = runtime.authMode === 'PASSWORD' ? 'sshpass' : 'scp';
    const result = await this.runLocalCommand(command, args, { env: runtime.env });

    const outputText = joinOutput(result.stdout, result.stderr, 8_000);
    if (outputText) {
      await this.appendLog(
        options.requestId,
        options.phase,
        result.code === 0 ? 'INFO' : 'ERROR',
        sanitizeText(outputText, options.secrets),
        options.seqState,
      );
    }

    if (result.code !== 0) {
      throw new Error(`${options.label} failed (exit ${result.code})`);
    }
  }

  private async runRemoteCommand(
    runtime: SshRuntime,
    remoteCommand: string,
    options: {
      requestId: string;
      phase: string;
      seqState: SeqState;
      secrets: Array<string | undefined>;
      label: string;
      allowFailure?: boolean;
      maxOutputLength?: number;
    },
  ) {
    await this.appendLog(
      options.requestId,
      options.phase,
      'INFO',
      `${options.label}...`,
      options.seqState,
    );

    const wrapped = `bash -lc ${shellEscape(remoteCommand)}`;
    const args =
      runtime.authMode === 'PASSWORD'
        ? ['-e', 'ssh', ...runtime.sshArgs, runtime.target, wrapped]
        : [...runtime.sshArgs, runtime.target, wrapped];
    const command = runtime.authMode === 'PASSWORD' ? 'sshpass' : 'ssh';

    const result = await this.runLocalCommand(command, args, {
      env: runtime.env,
      maxOutputLength: options.maxOutputLength,
    });

    const outputText = joinOutput(result.stdout, result.stderr, 30_000);
    if (outputText) {
      await this.appendLog(
        options.requestId,
        options.phase,
        result.code === 0 ? 'INFO' : 'ERROR',
        sanitizeText(outputText, options.secrets),
        options.seqState,
      );
    }

    if (result.code !== 0 && !options.allowFailure) {
      throw new Error(`${options.label} failed (exit ${result.code})`);
    }

    return result;
  }

  private buildInstallCommand(input: {
    remoteInstallerPath: string;
    remoteBinaryPath: string;
    request: {
      controlPlaneUrl: string;
      mcpBind: string;
      mcpPort: number;
      mcpAdvertiseUrl: string;
      allowedOrigins: string;
      allowInsecureDev: boolean;
      replaceExisting: boolean;
      installPath: string;
      serviceName: string;
    };
    enrollmentToken: string;
    sudoPassword?: string;
  }) {
    const parts: string[] = [];
    if (typeof input.sudoPassword === 'string') {
      parts.push(`SUDO_PASSWORD=${shellEscape(input.sudoPassword)}`);
    }

    parts.push(`bash ${shellEscape(input.remoteInstallerPath)}`);
    parts.push(`--binary ${shellEscape(input.remoteBinaryPath)}`);
    parts.push(`--control-plane ${shellEscape(input.request.controlPlaneUrl)}`);
    parts.push(`--enrollment-token ${shellEscape(input.enrollmentToken)}`);
    parts.push(`--mcp-bind ${shellEscape(input.request.mcpBind)}`);
    parts.push(`--mcp-port ${shellEscape(String(input.request.mcpPort))}`);
    parts.push(`--mcp-advertise-url ${shellEscape(input.request.mcpAdvertiseUrl)}`);
    parts.push(`--allowed-origins ${shellEscape(input.request.allowedOrigins)}`);
    if (input.request.allowInsecureDev) {
      parts.push('--allow-insecure-dev');
    }
    if (input.request.replaceExisting) {
      parts.push('--replace-existing');
    } else {
      parts.push('--keep-existing');
    }
    parts.push(`--install-path ${shellEscape(input.request.installPath)}`);
    parts.push(`--service-name ${shellEscape(input.request.serviceName)}`);
    parts.push('--run-mode systemd');
    parts.push('--yes');
    return parts.join(' ');
  }

  private buildRollbackCommand(input: {
    remoteInstallerPath: string;
    request: {
      serviceName: string;
    };
    sudoPassword?: string;
  }) {
    const parts: string[] = [];
    if (typeof input.sudoPassword === 'string') {
      parts.push(`SUDO_PASSWORD=${shellEscape(input.sudoPassword)}`);
    }
    parts.push(`bash ${shellEscape(input.remoteInstallerPath)}`);
    parts.push('--uninstall');
    parts.push(`--service-name ${shellEscape(input.request.serviceName)}`);
    parts.push('--yes');
    return parts.join(' ');
  }

  /**
   * Handles resolve installer script path.
   */
  private async resolveInstallerScriptPath() {
    const candidates = [
      path.resolve(process.cwd(), 'scripts/install-labagent.sh'),
      path.resolve(process.cwd(), '../../scripts/install-labagent.sh'),
      path.resolve(__dirname, '../../../../../scripts/install-labagent.sh'),
    ];

    const uniqueCandidates = Array.from(new Set(candidates));
    for (const candidate of uniqueCandidates) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) {
          continue;
        }
        await fs.access(candidate, fsConstants.R_OK);
        return candidate;
      } catch {
        // Try the next candidate path.
      }
    }

    throw new Error(`Installer script not found. Looked in: ${uniqueCandidates.join(', ')}`);
  }

  private async runLocalCommand(
    command: string,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      maxOutputLength?: number;
    },
  ): Promise<RunCommandResult> {
    const maxOutputLength = options?.maxOutputLength ?? maxStoredOutputChars;

    return new Promise<RunCommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        env: {
          ...process.env,
          ...(options?.env ?? {}),
        },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout = appendWithLimit(stdout, chunk.toString('utf8'), maxOutputLength);
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendWithLimit(stderr, chunk.toString('utf8'), maxOutputLength);
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }

  /**
   * Handles next log seq.
   */
  private async nextLogSeq(requestId: string) {
    const latest = await this.prisma.agentInstallLog.findFirst({
      where: { requestId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return (latest?.seq ?? -1) + 1;
  }

  private async appendLog(
    requestId: string,
    phase: string,
    level: LogLevel,
    message: string,
    seqState?: SeqState,
  ) {
    const seq = seqState ? seqState.next++ : await this.nextLogSeq(requestId);

    const created = await this.prisma.agentInstallLog.create({
      data: {
        requestId,
        seq,
        phase,
        level,
        message: truncateMessage(message),
      },
    });

    this.stream$.next({
      requestId,
      type: 'log',
      payload: {
        log: {
          id: created.id,
          seq: created.seq,
          phase: created.phase,
          level: created.level,
          message: created.message,
          createdAt: created.createdAt.toISOString(),
        },
      },
    });
  }

  private async revokeLinkedAgentSafe(
    agentId: string,
    actorUserId: string,
  ): Promise<string | null> {
    try {
      const revokeResult = await this.agentsService.revoke(agentId, actorUserId);
      if (revokeResult.alreadyRevoked) {
        return 'Linked agent was already revoked.';
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Failed to revoke linked agent';
    }
  }

  private async revokeEnrollmentTokenSafe(
    tokenId: string,
    actorUserId: string,
  ): Promise<string | null> {
    try {
      await this.agentsService.revokeEnrollmentToken(tokenId, actorUserId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Failed to revoke enrollment token';
    }
  }

  /**
   * Handles publish status from id.
   */
  private async publishStatusFromId(requestId: string) {
    const request = await this.prisma.agentInstallRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      return;
    }
    this.publishStatus(request);
  }

  private publishStatus(request: {
    id: string;
    status: DbAgentInstallStatus;
    startedAt: Date | null;
    finishedAt: Date | null;
    resultCode: string | null;
    resultSummary: string | null;
    errorMessageSanitized: string | null;
  }) {
    this.stream$.next({
      requestId: request.id,
      type: 'status',
      payload: {
        status: {
          id: request.id,
          status: request.status,
          startedAt: request.startedAt?.toISOString() ?? null,
          finishedAt: request.finishedAt?.toISOString() ?? null,
          resultCode: request.resultCode,
          resultSummary: request.resultSummary,
          errorMessageSanitized: request.errorMessageSanitized,
        },
      },
    });
  }

  /**
   * Gets binary store root.
   */
  private getBinaryStoreRoot() {
    const configuredRoot =
      this.configService.get<string>('AGENT_BINARY_STORE_ROOT', defaultBinaryStoreRoot)?.trim() ??
      '';
    return configuredRoot || defaultBinaryStoreRoot;
  }

  /**
   * Builds local binary path.
   */
  private buildLocalBinaryPath(version: string, platform: 'linux-amd64' | 'linux-arm64') {
    return path.join(this.getBinaryStoreRoot(), version, `labagent-${platform}`);
  }

  /**
   * Handles resolve local binary path.
   */
  private async resolveLocalBinaryPath(version: string, platform: 'linux-amd64' | 'linux-arm64') {
    const normalizedVersion = version.trim();
    if (!isSafeBinaryVersion(normalizedVersion)) {
      throw new Error(`Invalid binary version requested: ${normalizedVersion || 'empty'}`);
    }

    const localBinaryPath = this.buildLocalBinaryPath(normalizedVersion, platform);
    try {
      const stat = await fs.stat(localBinaryPath);
      if (!stat.isFile()) {
        throw new Error('Not a file');
      }
      await fs.access(localBinaryPath, fsConstants.R_OK);
      return localBinaryPath;
    } catch {
      throw new Error(
        `Binary not available for version ${normalizedVersion} platform ${platform} on control plane`,
      );
    }
  }

  /**
   * Handles collect binary manifest entries.
   */
  private async collectBinaryManifestEntries(defaultVersion: string) {
    const storeRoot = this.getBinaryStoreRoot();
    const versions = new Set<string>([defaultVersion]);

    try {
      const entries = await fs.readdir(storeRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (isSafeBinaryVersion(entry.name)) {
          versions.add(entry.name);
        }
      }
    } catch {
      // Missing/empty binary store is represented as unavailable manifest entries.
    }

    const sortedVersions = Array.from(versions).sort();
    const platforms: Array<'linux-amd64' | 'linux-arm64'> = ['linux-amd64', 'linux-arm64'];
    const binaries: Array<{
      version: string;
      platform: 'linux-amd64' | 'linux-arm64';
      available: boolean;
    }> = [];

    for (const version of sortedVersions) {
      for (const platform of platforms) {
        const binaryPath = this.buildLocalBinaryPath(version, platform);
        let available = false;
        try {
          const stat = await fs.stat(binaryPath);
          if (stat.isFile()) {
            await fs.access(binaryPath, fsConstants.R_OK);
            available = true;
          }
        } catch {
          available = false;
        }
        binaries.push({ version, platform, available });
      }
    }

    return binaries;
  }

  /**
   * Handles serialize request.
   */
  private serializeRequest(request: InstallRequestRecord) {
    const logsRaw = request.logs;
    return {
      id: request.id,
      action: request.action,
      status: request.status,
      requestedByUserId: request.requestedByUserId,
      approvedByUserId: request.approvedByUserId,
      deniedByUserId: request.deniedByUserId,
      targetHostId: request.targetHostId,
      targetHost: request.targetHost,
      targetPort: request.targetPort,
      targetUsername: request.targetUsername,
      authMode: request.authMode,
      binaryVersion: request.binaryVersion,
      binaryUrlResolved: request.binaryUrlResolved,
      controlPlaneUrl: request.controlPlaneUrl,
      mcpBind: request.mcpBind,
      mcpPort: request.mcpPort,
      mcpAdvertiseUrl: request.mcpAdvertiseUrl,
      allowedOrigins: request.allowedOrigins,
      allowInsecureDev: request.allowInsecureDev,
      replaceExisting: request.replaceExisting,
      installPath: request.installPath,
      serviceName: request.serviceName,
      rollbackOfRequestId: request.rollbackOfRequestId,
      resultCode: request.resultCode,
      resultSummary: request.resultSummary,
      errorMessageSanitized: request.errorMessageSanitized,
      agentIdLinked: request.agentIdLinked,
      approvedAt: request.approvedAt?.toISOString() ?? null,
      startedAt: request.startedAt?.toISOString() ?? null,
      finishedAt: request.finishedAt?.toISOString() ?? null,
      deniedAt: request.deniedAt?.toISOString() ?? null,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
      logs: logsRaw?.map((log) => ({
        id: log.id,
        seq: log.seq,
        phase: log.phase,
        level: log.level,
        message: log.message,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * Implements truncate message.
 */
function truncateMessage(message: string) {
  if (message.length <= 5_000) {
    return message;
  }
  return `${message.slice(0, 4_900)}\n...[truncated]`;
}

/**
 * Implements normalize int limit.
 */
function normalizeIntLimit(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultValue;
  }
  const rounded = Math.trunc(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

/**
 * Implements append with limit.
 */
function appendWithLimit(current: string, next: string, max: number) {
  const merged = `${current}${next}`;
  if (merged.length <= max) {
    return merged;
  }
  return merged.slice(merged.length - max);
}

/**
 * Implements join output.
 */
function joinOutput(stdout: string, stderr: string, max: number) {
  const joined = [stdout.trim(), stderr.trim()].filter((entry) => entry.length > 0).join('\n');
  if (joined.length <= max) {
    return joined;
  }
  return `${joined.slice(0, max)}\n...[truncated]`;
}

/**
 * Implements first non empty line.
 */
function firstNonEmptyLine(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] ?? '';
}

/**
 * Parses agent id.
 */
function parseAgentId(text: string): string | null {
  const match = text.match(/Agent ID:\s*([0-9a-fA-F-]{36})/);
  return match?.[1] ?? null;
}

/**
 * Implements shell escape.
 */
function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Implements sanitize text.
 */
function sanitizeText(input: string, secrets: Array<string | undefined>) {
  let sanitized = input;

  for (const secret of secrets) {
    if (!secret || secret.length < 4) {
      continue;
    }
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }

  sanitized = sanitized.replace(/(Agent Token:\s*)([^\s]+)/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/(enrollmentToken[=:]\s*)([^\s]+)/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/(password[=:]\s*)([^\s]+)/gi, '$1[REDACTED]');
  sanitized = sanitized.replace(/(AGENT_TOKEN=)([^\n\r]+)/g, '$1[REDACTED]');
  sanitized = sanitized.replace(/(SUDO_PASSWORD=)([^\s]+)/g, '$1[REDACTED]');
  return sanitized;
}

/**
 * Checks whether safe host token.
 */
function isSafeHostToken(value: string) {
  return /^[a-zA-Z0-9._:-]+$/.test(value.trim());
}

/**
 * Checks whether safe username.
 */
function isSafeUsername(value: string) {
  return /^[a-z_][a-z0-9._-]*$/i.test(value.trim());
}

/**
 * Checks whether safe binary version.
 */
function isSafeBinaryVersion(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value.trim());
}

/**
 * Checks whether safe service name.
 */
function isSafeServiceName(value: string) {
  return /^[a-zA-Z0-9._-]+$/.test(value.trim());
}

/**
 * Checks whether safe absolute path.
 */
function isSafeAbsolutePath(value: string) {
  if (!value.startsWith('/')) {
    return false;
  }
  if (value.includes('..')) {
    return false;
  }
  return /^[\w./-]+$/.test(value);
}

/**
 * Implements map arch to platform.
 */
function mapArchToPlatform(rawArch: string): 'linux-amd64' | 'linux-arm64' | null {
  const normalized = rawArch.trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'amd64') {
    return 'linux-amd64';
  }
  if (normalized === 'aarch64' || normalized === 'arm64') {
    return 'linux-arm64';
  }
  return null;
}

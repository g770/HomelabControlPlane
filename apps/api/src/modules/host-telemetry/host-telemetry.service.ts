/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements host telemetry service business logic for the service layer.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  hostTelemetryConfigResponseSchema,
  hostTelemetryRefreshResponseSchema,
  type HostTelemetryConfigUpdate,
  type HostTelemetryRefreshRequest,
} from '@homelab/shared';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { McpService } from '../mcp/mcp.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
/**
 * Implements the host telemetry service class.
 */
export class HostTelemetryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpService: McpService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Gets config.
   */
  async getConfig(actorUserId: string, hostId: string) {
    const { host, agent } = await this.resolveHostAgent(hostId);
    const raw = await this.mcpService.callTool({
      actorUserId,
      agentId: agent.id,
      toolName: 'agent.telemetry.get_config',
      toolParams: {},
    });

    const config = extractTelemetryConfig(raw);
    return hostTelemetryConfigResponseSchema.parse({
      hostId: host.id,
      agentId: agent.id,
      config,
      fetchedAt: new Date().toISOString(),
    });
  }

  /**
   * Handles update config.
   */
  async updateConfig(actorUserId: string, hostId: string, body: HostTelemetryConfigUpdate) {
    const { host, agent } = await this.resolveHostAgent(hostId);
    const toolParams: Record<string, unknown> = {
      confirm: true,
    };
    if (body.heartbeatSec !== undefined) {
      toolParams.heartbeatSec = body.heartbeatSec;
    }
    if (body.factsSec !== undefined) {
      toolParams.factsSec = body.factsSec;
    }
    if (body.inventorySec !== undefined) {
      toolParams.inventorySec = body.inventorySec;
    }

    const raw = await this.mcpService.callTool({
      actorUserId,
      agentId: agent.id,
      toolName: 'agent.telemetry.set_config',
      toolParams,
      allowWrite: true,
    });

    const config = extractTelemetryConfig(raw);
    await this.auditService.write({
      actorUserId,
      action: 'host.telemetry.config.update',
      targetType: 'host',
      targetId: host.id,
      paramsJson: toolParams as Prisma.InputJsonValue,
      resultJson: {
        agentId: agent.id,
        config,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return hostTelemetryConfigResponseSchema.parse({
      hostId: host.id,
      agentId: agent.id,
      config,
      fetchedAt: new Date().toISOString(),
    });
  }

  /**
   * Handles refresh now.
   */
  async refreshNow(actorUserId: string, hostId: string, body: HostTelemetryRefreshRequest) {
    const { host, agent } = await this.resolveHostAgent(hostId);
    const reason = normalizeReason(body.reason);

    const raw = await this.mcpService.callTool({
      actorUserId,
      agentId: agent.id,
      toolName: 'agent.telemetry.refresh_now',
      toolParams: {
        confirm: true,
        reason,
      },
      allowWrite: true,
    });

    const result = toRecord(raw.result);
    const queued = typeof result?.queued === 'boolean' ? result.queued : true;
    const requestedAt =
      typeof result?.requestedAt === 'string' ? result.requestedAt : new Date().toISOString();

    await this.auditService.write({
      actorUserId,
      action: 'host.telemetry.refresh',
      targetType: 'host',
      targetId: host.id,
      paramsJson: {
        reason,
      } as Prisma.InputJsonValue,
      resultJson: {
        agentId: agent.id,
        queued,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return hostTelemetryRefreshResponseSchema.parse({
      hostId: host.id,
      agentId: agent.id,
      queued,
      reason,
      requestedAt,
    });
  }

  /**
   * Handles resolve host agent.
   */
  private async resolveHostAgent(hostId: string) {
    const host = await this.prisma.host.findUnique({
      where: { id: hostId },
      select: { id: true },
    });
    if (!host) {
      throw new NotFoundException('Host not found');
    }

    const agent = await this.prisma.agent.findFirst({
      where: {
        hostId,
        revokedAt: null,
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
      },
    });
    if (!agent) {
      throw new NotFoundException('No active agent is enrolled for this host');
    }

    return { host, agent };
  }
}

/**
 * Implements extract telemetry config.
 */
function extractTelemetryConfig(raw: Record<string, unknown>) {
  const result = toRecord(raw.result);
  const configRecord = toRecord(result?.config) ?? result;
  if (!configRecord) {
    throw new BadRequestException('Invalid telemetry config response from agent');
  }

  return {
    heartbeatSec: requireNumber(configRecord, 'heartbeatSec'),
    factsSec: requireNumber(configRecord, 'factsSec'),
    inventorySec: requireNumber(configRecord, 'inventorySec'),
    minSec: requireNumber(configRecord, 'minSec'),
    maxSec: requireNumber(configRecord, 'maxSec'),
    updatedAt:
      typeof configRecord.updatedAt === 'string' && configRecord.updatedAt.trim().length > 0
        ? configRecord.updatedAt
        : new Date().toISOString(),
  };
}

/**
 * Implements require number.
 */
function requireNumber(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new BadRequestException(`Invalid telemetry config field: ${key}`);
}

/**
 * Implements normalize reason.
 */
function normalizeReason(reason: string | undefined) {
  if (typeof reason !== 'string') {
    return 'manual';
  }
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : 'manual';
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

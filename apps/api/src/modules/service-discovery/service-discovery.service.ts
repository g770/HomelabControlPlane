/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements service discovery service business logic for the service layer.
 */
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  serviceDiscoveryCatalogResponseSchema,
  serviceDiscoveryConfigResponseSchema,
  serviceDiscoveryRunDeleteResponseSchema,
  serviceDiscoveryRunHistoryResponseSchema,
  serviceDiscoveryRunResponseSchema,
  type ServiceDiscoveryConfig,
  type ServiceDiscoveryRunDeleteResponse,
  type ServiceDiscoveryRunResponse,
} from '@homelab/shared';
import { AiProviderService } from '../ai/ai-provider.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { McpService } from '../mcp/mcp.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BUILTIN_DISCOVERY_SIGNATURES,
  mergeServiceDiscoverySignatures,
  type DiscoveryProbeTemplate,
  type ServiceDiscoverySignature,
} from './service-discovery.catalog';
import { computeDiscoveryScore, type PassiveEvidence } from './service-discovery.scoring';
import { aiCatalogEnvelopeSchema, discoveryRunSummarySchema } from './service-discovery.schemas';
import {
  isIpLikeHostname,
  normalizeHostName,
  normalizePrimaryIp,
  normalizeServiceInstancesForHost,
  resolveCanonicalHostByIdentity,
} from '../common/host-identity';

type DiscoveryTrigger = 'SCHEDULE' | 'MANUAL';
type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
type DiscoveryRunStage =
  | 'initializing'
  | 'host-scan'
  | 'upsert'
  | 'subnet-scan'
  | 'verification'
  | 'finalizing'
  | 'failed';
type DiscoveryConsoleLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

type DiscoveryConsoleEntry = {
  seq: number;
  timestamp: string;
  level: DiscoveryConsoleLevel;
  message: string;
};

type DiscoveryRunProgress = {
  stage: DiscoveryRunStage;
  selectedHosts: number;
  scannedHosts: number;
  probes: number;
  subnetIpsProbed: number;
  subnetIpsUnique: number;
  subnetIpsReachable: number;
  detections: number;
  upserts: number;
  errors: number;
};

type DiscoveryRunConsoleState = {
  runId: string;
  entries: DiscoveryConsoleEntry[];
  truncated: boolean;
  nextSeq: number;
  lastPersistedAtMs: number;
};

type ProbeResult = {
  matched: boolean;
  reachable: boolean;
  endpoint: string | null;
  details: Record<string, unknown>;
};

type HostDiscoveryResult = {
  hostId: string;
  hostName: string;
  probeCount: number;
  detections: Array<{
    signature: ServiceDiscoverySignature;
    passive: PassiveEvidence;
    confidence: number;
    endpoint: string | null;
    probeEvidence: { attempted: number; matched: number };
  }>;
  errors: string[];
};

type SubnetScanDetection = {
  ip: string;
  hostname: string | null;
  serviceId: string;
  serviceName: string;
  endpoint: string | null;
  confidence: number;
  source: 'signature' | 'common-web';
  tags: string[];
  evidence: Record<string, unknown>;
};

type AgentSubnetScanResult = {
  agentId: string;
  hostId: string;
  hostName: string;
  cidrs: string[];
  hostsScanned: number;
  hostsReachable: number;
  probedIps: string[];
  reachableIps: string[];
  detections: SubnetScanDetection[];
  warnings: string[];
};

type AgentSubnetScanJobState = 'RUNNING' | 'COMPLETED' | 'FAILED';

type AgentSubnetScanJobStatus = {
  jobId: string;
  state: AgentSubnetScanJobState;
  error: string | null;
  hostsScanned: number;
  hostsReachable: number;
  detections: number;
  warnings: string[];
};

type DiscoverySubnetConfig = {
  enabled: boolean;
  cidrs: string[];
  includeAutoLocalCidrs: boolean;
  includeCommonWebPorts: boolean;
  maxHosts: number;
  concurrency: number;
  connectTimeoutMs: number;
  toolCallTimeoutMs: number;
};

type DiscoveryVerificationSummary = {
  hostsChecked: number;
  hostsUp: number;
  hostsDown: number;
  hostsSkipped: number;
  servicesChecked: number;
  servicesUp: number;
  servicesDown: number;
  servicesSkipped: number;
  errors: number;
};

const DISCOVERY_CATALOG_ID = 'global';
const DISCOVERY_CONFIG_ID = 'global';
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_SUBNET_CIDRS = ['10.0.0.0/24', '172.16.0.0/24', '192.168.1.0/24'];
const AI_CATALOG_MAX_BYTES = 120_000;
const DISCOVERY_CONSOLE_MAX_ENTRIES = 800;
const DISCOVERY_CONSOLE_PERSIST_TAIL = 300;
const DISCOVERY_CONSOLE_PERSIST_INTERVAL_MS = 1_000;
const DISCOVERY_CONSOLE_MESSAGE_MAX = 220;
const SUBNET_SCAN_STATUS_POLL_MS = 1_000;
const SUBNET_SCAN_RESULT_GRACE_MS = 30_000;
const SUBNET_SCAN_TOOL_START = 'network.scan_known_services.start';
const SUBNET_SCAN_TOOL_STATUS = 'network.scan_known_services.status';
const SUBNET_SCAN_TOOL_RESULT = 'network.scan_known_services.result';

@Injectable()
/**
 * Implements the service discovery service class.
 */
export class ServiceDiscoveryService {
  private runActive = false;
  private activeRunId: string | null = null;
  private activeRunConsole: DiscoveryRunConsoleState | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mcpService: McpService,
    private readonly auditService: AuditService,
    private readonly eventsService: EventsService,
    private readonly aiProviderService: AiProviderService,
  ) {}

  /**
   * Checks whether discovery enabled.
   */
  isDiscoveryEnabled() {
    return this.configService.get<boolean>('DISCOVERY_ENABLED', true);
  }

  /**
   * Gets interval ms.
   */
  getIntervalMs() {
    const intervalSec = this.configService.get<number>('DISCOVERY_INTERVAL_SEC', 600);
    return Math.max(60, intervalSec) * 1_000;
  }

  /**
   * Gets config store.
   */
  private getConfigStore() {
    const delegate = (
      this.prisma as unknown as {
        serviceDiscoveryConfig?: {
          upsert: (args: Record<string, unknown>) => Promise<{ id: string }>;
          findUnique: (args: Record<string, unknown>) => Promise<{
            subnetEnabled: boolean;
            subnetCidrs: string[];
            includeAutoLocalCidrs: boolean;
            includeCommonWebPorts: boolean;
            subnetMaxHosts: number;
            subnetConcurrency: number;
            subnetConnectTimeoutMs: number;
            subnetToolCallTimeoutMs: number;
            updatedAt: Date;
          } | null>;
        };
      }
    ).serviceDiscoveryConfig;

    if (!delegate) {
      throw new InternalServerErrorException('Service discovery config storage is unavailable');
    }
    return delegate;
  }

  /**
   * Gets config.
   */
  async getConfig() {
    const [configState, latestRun] = await Promise.all([
      this.readDiscoveryConfig(),
      this.prisma.serviceDiscoveryRun.findFirst({
        orderBy: [{ startedAt: 'desc' }],
        select: {
          startedAt: true,
        },
      }),
    ]);
    const intervalMs = this.getIntervalMs();
    const intervalSec = Math.floor(intervalMs / 1_000);
    const nowMs = Date.now();
    const nextDueMs = latestRun?.startedAt
      ? Math.max(nowMs, latestRun.startedAt.getTime() + intervalMs)
      : nowMs + intervalMs;

    return serviceDiscoveryConfigResponseSchema.parse({
      config: configState.config,
      intervalSec,
      nextScheduledRunAt: new Date(nextDueMs).toISOString(),
      lastRunAt: latestRun?.startedAt ? latestRun.startedAt.toISOString() : null,
      isRunning: this.runActive,
      updatedAt: configState.updatedAt,
    });
  }

  /**
   * Handles update config.
   */
  async updateConfig(actorUserId: string, config: ServiceDiscoveryConfig) {
    const normalized = this.normalizeDiscoveryConfig(config);
    const configStore = this.getConfigStore();
    const persisted = await configStore.upsert({
      where: {
        id: DISCOVERY_CONFIG_ID,
      },
      update: {
        subnetEnabled: normalized.enabled,
        subnetCidrs: normalized.cidrs,
        includeAutoLocalCidrs: normalized.includeAutoLocalCidrs,
        includeCommonWebPorts: normalized.includeCommonWebPorts,
        subnetMaxHosts: normalized.maxHosts,
        subnetConcurrency: normalized.concurrency,
        subnetConnectTimeoutMs: normalized.connectTimeoutMs,
        subnetToolCallTimeoutMs: normalized.toolCallTimeoutMs,
      },
      create: {
        id: DISCOVERY_CONFIG_ID,
        subnetEnabled: normalized.enabled,
        subnetCidrs: normalized.cidrs,
        includeAutoLocalCidrs: normalized.includeAutoLocalCidrs,
        includeCommonWebPorts: normalized.includeCommonWebPorts,
        subnetMaxHosts: normalized.maxHosts,
        subnetConcurrency: normalized.concurrency,
        subnetConnectTimeoutMs: normalized.connectTimeoutMs,
        subnetToolCallTimeoutMs: normalized.toolCallTimeoutMs,
      },
      select: {
        id: true,
      },
    });

    await this.auditService.write({
      actorUserId,
      action: 'service.discovery.config.update',
      targetType: 'service_discovery_config',
      targetId: persisted.id,
      paramsJson: normalized as Prisma.InputJsonValue,
      success: true,
    });

    return this.getConfig();
  }

  /**
   * Checks whether run active.
   */
  isRunActive() {
    return this.runActive;
  }

  async triggerManualRun(
    userId: string,
    input: {
      hostId?: string;
    },
  ): Promise<ServiceDiscoveryRunResponse> {
    if (!this.isDiscoveryEnabled()) {
      throw new BadRequestException('Service discovery is disabled');
    }

    await this.auditService.write({
      actorUserId: userId,
      action: 'service.discovery.trigger',
      targetType: 'service_discovery',
      paramsJson: {
        trigger: 'MANUAL',
        hostId: input.hostId ?? null,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return this.runDiscovery({
      trigger: 'MANUAL',
      triggeredByUserId: userId,
      hostId: input.hostId,
    });
  }

  /**
   * Handles trigger scheduled run if due.
   */
  async triggerScheduledRunIfDue() {
    if (!this.isDiscoveryEnabled()) {
      return;
    }
    if (this.runActive) {
      return;
    }

    const now = Date.now();
    const latestRun = await this.prisma.serviceDiscoveryRun.findFirst({
      orderBy: [{ startedAt: 'desc' }],
      select: {
        startedAt: true,
      },
    });
    if (latestRun && now - latestRun.startedAt.getTime() < this.getIntervalMs()) {
      return;
    }

    try {
      await this.runDiscovery({
        trigger: 'SCHEDULE',
      });
    } catch {
      // Fail closed without throwing out of scheduler tick.
    }
  }

  /**
   * Handles list runs.
   */
  async listRuns(limit: number | undefined = 20) {
    const bounded = normalizeIntLimit(limit, 20, 1, 100);
    const runs = await this.prisma.serviceDiscoveryRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: bounded,
      select: {
        id: true,
        trigger: true,
        triggeredByUserId: true,
        startedAt: true,
        finishedAt: true,
        status: true,
        hostCount: true,
        probeCount: true,
        detectedCount: true,
        upsertCount: true,
        errorCount: true,
        error: true,
        summary: true,
      },
    });

    return serviceDiscoveryRunHistoryResponseSchema.parse({
      runs: runs.map((run) => ({
        id: run.id,
        trigger: run.trigger as 'SCHEDULE' | 'MANUAL',
        triggeredByUserId: run.triggeredByUserId,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        status: run.status as RunStatus,
        hostCount: run.hostCount,
        probeCount: run.probeCount,
        detectedCount: run.detectedCount,
        upsertCount: run.upsertCount,
        errorCount: run.errorCount,
        error: run.error,
        summary: run.summary,
      })),
    });
  }

  /**
   * Removes run from the surrounding workflow.
   */
  async deleteRun(runId: string, actorUserId: string): Promise<ServiceDiscoveryRunDeleteResponse> {
    const existing = await this.prisma.serviceDiscoveryRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
      },
    });

    if (!existing) {
      throw new NotFoundException('Discovery run not found');
    }

    if (existing.status === 'RUNNING' || this.activeRunId === existing.id) {
      throw new BadRequestException('Cannot delete a discovery run that is in progress');
    }

    await this.prisma.serviceDiscoveryRun.delete({
      where: { id: existing.id },
    });

    await this.auditService.write({
      actorUserId,
      action: 'service.discovery.run.delete',
      targetType: 'service_discovery_run',
      targetId: existing.id,
      resultJson: {
        deleted: true,
        status: existing.status,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return serviceDiscoveryRunDeleteResponseSchema.parse({
      ok: true,
      deleted: true,
      runId: existing.id,
    });
  }

  /**
   * Gets effective catalog.
   */
  async getEffectiveCatalog() {
    const catalog = await this.loadEffectiveCatalog();
    return serviceDiscoveryCatalogResponseSchema.parse({
      id: DISCOVERY_CATALOG_ID,
      source: catalog.source,
      expiresAt: catalog.expiresAt.toISOString(),
      lastError: catalog.lastError,
      serviceCount: catalog.signatures.length,
      services: catalog.signatures,
    });
  }

  /**
   * Handles initialize run console.
   */
  private initializeRunConsole(runId: string) {
    this.activeRunConsole = {
      runId,
      entries: [],
      truncated: false,
      nextSeq: 1,
      lastPersistedAtMs: 0,
    };
  }

  /**
   * Handles clear run console.
   */
  private clearRunConsole(runId: string) {
    if (this.activeRunConsole?.runId === runId) {
      this.activeRunConsole = null;
    }
  }

  /**
   * Handles read run console payload.
   */
  private readRunConsolePayload(runId: string) {
    const state = this.activeRunConsole;
    if (!state || state.runId !== runId) {
      return {
        entries: [] as DiscoveryConsoleEntry[],
        truncated: false,
        lastSeq: 0,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      entries: state.entries.slice(-DISCOVERY_CONSOLE_PERSIST_TAIL),
      truncated: state.truncated,
      lastSeq: Math.max(0, state.nextSeq - 1),
      updatedAt: new Date().toISOString(),
    };
  }

  private async appendRunConsole(
    runId: string,
    entry: {
      level: DiscoveryConsoleLevel;
      message: string;
    },
    progress: DiscoveryRunProgress,
    options?: {
      flush?: boolean;
    },
  ) {
    const state = this.activeRunConsole;
    if (!state || state.runId !== runId) {
      return;
    }

    state.entries.push({
      seq: state.nextSeq,
      timestamp: new Date().toISOString(),
      level: entry.level,
      message: sanitizeConsoleMessage(entry.message),
    });
    state.nextSeq += 1;
    if (state.entries.length > DISCOVERY_CONSOLE_MAX_ENTRIES) {
      const overflow = state.entries.length - DISCOVERY_CONSOLE_MAX_ENTRIES;
      state.entries.splice(0, overflow);
      state.truncated = true;
    }

    const now = Date.now();
    const shouldPersist =
      options?.flush === true ||
      now - state.lastPersistedAtMs >= DISCOVERY_CONSOLE_PERSIST_INTERVAL_MS;
    if (!shouldPersist) {
      return;
    }

    await this.persistRunConsole(runId, progress);
  }

  /**
   * Handles persist run console.
   */
  private async persistRunConsole(runId: string, progress: DiscoveryRunProgress) {
    const state = this.activeRunConsole;
    if (!state || state.runId !== runId) {
      return;
    }

    try {
      state.lastPersistedAtMs = Date.now();
      await this.prisma.serviceDiscoveryRun.update({
        where: { id: runId },
        data: {
          summary: {
            progress,
            console: this.readRunConsolePayload(runId),
          } as Prisma.InputJsonValue,
        },
      });
    } catch {
      // Console persistence is best-effort telemetry and must not abort discovery.
    }
  }

  private async runDiscovery(params: {
    trigger: DiscoveryTrigger;
    triggeredByUserId?: string;
    hostId?: string;
  }): Promise<ServiceDiscoveryRunResponse> {
    if (this.runActive) {
      throw new BadRequestException('A discovery run is already in progress');
    }

    const agents = await this.loadTargetAgents(params.hostId);
    if (agents.length === 0) {
      throw new BadRequestException('No eligible online agents are available to run discovery.');
    }

    this.runActive = true;
    let runRecord: { id: string; startedAt: Date } | null = null;
    let runId: string | null = null;
    const progress: DiscoveryRunProgress = {
      stage: 'initializing',
      selectedHosts: 0,
      scannedHosts: 0,
      probes: 0,
      subnetIpsProbed: 0,
      subnetIpsUnique: 0,
      subnetIpsReachable: 0,
      detections: 0,
      upserts: 0,
      errors: 0,
    };

    try {
      runRecord = await this.prisma.serviceDiscoveryRun.create({
        data: {
          trigger: params.trigger,
          triggeredByUserId: params.triggeredByUserId,
          status: 'RUNNING',
        },
        select: {
          id: true,
          startedAt: true,
        },
      });
      runId = runRecord.id;
      this.activeRunId = runId;
      this.initializeRunConsole(runId!);

      await this.appendRunConsole(
        runId!,
        {
          level: 'INFO',
          message: `Run started (${params.trigger.toLowerCase()})`,
        },
        progress,
        { flush: true },
      );

      const catalog = await this.loadEffectiveCatalog();
      await this.appendRunConsole(
        runId!,
        {
          level: 'INFO',
          message: `Loaded ${catalog.signatures.length} discovery signatures (${catalog.source.toLowerCase()})`,
        },
        progress,
      );
      const discoveryConfig = await this.readDiscoveryConfig();
      const subnetSettings = discoveryConfig.config;
      const appliedConfig = {
        subnetScan: subnetSettings,
      };
      const maxHosts = this.configService.get<number>('DISCOVERY_MAX_HOSTS_PER_RUN', 120);
      const threshold = this.configService.get<number>('DISCOVERY_CONFIDENCE_THRESHOLD', 0.75);
      const autoUpsert = this.configService.get<boolean>('DISCOVERY_AUTO_UPSERT', true);

      const selectedAgents = agents.slice(0, Math.max(1, maxHosts));
      progress.selectedHosts = selectedAgents.filter((agent) => Boolean(agent.hostId)).length;
      progress.stage = 'host-scan';
      await this.appendRunConsole(
        runId!,
        {
          level: 'INFO',
          message: `Scanning ${progress.selectedHosts} host(s)`,
        },
        progress,
        { flush: true },
      );
      if (progress.selectedHosts === 0) {
        await this.appendRunConsole(
          runId!,
          {
            level: 'WARN',
            message:
              'No eligible online agents with host bindings were found. Check agent status and host enrollment.',
          },
          progress,
        );
      }

      const hostResults: HostDiscoveryResult[] = [];

      for (const agent of selectedAgents) {
        if (!agent.hostId) {
          continue;
        }
        const hostName = agent.host?.hostname ?? 'unknown';
        await this.appendRunConsole(
          runId!,
          {
            level: 'INFO',
            message: `Host ${hostName}: collecting passive evidence`,
          },
          progress,
        );
        const result = await this.discoverForHost({
          agentId: agent.id,
          hostId: agent.hostId,
          hostName,
          signatures: catalog.signatures,
          confidenceThreshold: threshold,
          onProbeResult: async (probeEvent) => {
            progress.probes += 1;
            await this.appendRunConsole(
              runId!,
              {
                level: probeEvent.result.matched
                  ? 'SUCCESS'
                  : probeEvent.result.reachable
                    ? 'INFO'
                    : 'WARN',
                message: `${probeEvent.hostName}: probe ${probeEvent.signatureId} ${formatProbeLabel(
                  probeEvent.probe,
                )} -> ${
                  probeEvent.result.matched
                    ? 'matched'
                    : probeEvent.result.reachable
                      ? 'no match'
                      : 'unreachable'
                }`,
              },
              progress,
            );
          },
          onDetection: async (detectionEvent) => {
            await this.appendRunConsole(
              runId!,
              {
                level: 'SUCCESS',
                message: `${detectionEvent.hostName}: detected ${detectionEvent.signatureName} (${Math.round(
                  detectionEvent.confidence * 100,
                )}% confidence)`,
              },
              progress,
            );
          },
          onError: async (errorMessage) => {
            await this.appendRunConsole(
              runId!,
              {
                level: 'WARN',
                message: `${hostName}: passive collection warning - ${errorMessage}`,
              },
              progress,
            );
          },
        });
        hostResults.push(result);
        progress.scannedHosts += 1;
        progress.detections += result.detections.length;
        progress.errors += result.errors.length;
        await this.appendRunConsole(
          runId!,
          {
            level: 'INFO',
            message: `Host ${result.hostName}: probes=${result.probeCount}, detections=${result.detections.length}, warnings=${result.errors.length}`,
          },
          progress,
          { flush: true },
        );
      }

      const localProbeCount = hostResults.reduce((total, item) => total + item.probeCount, 0);
      const detections = hostResults.flatMap((item) => item.detections);
      const errorCount = hostResults.reduce((total, item) => total + item.errors.length, 0);

      let upsertCount = 0;
      progress.stage = 'upsert';
      if (autoUpsert) {
        for (const hostResult of hostResults) {
          for (const detection of hostResult.detections) {
            const created = await this.upsertDiscovery(
              {
                agentId:
                  selectedAgents.find((agent) => agent.hostId === hostResult.hostId)?.id ?? null,
                hostId: hostResult.hostId,
                hostName: hostResult.hostName,
              },
              detection,
              {
                actorUserId: params.triggeredByUserId,
                runId: runId!,
              },
            );
            upsertCount += created;
            if (created > 0) {
              progress.upserts += created;
              await this.appendRunConsole(
                runId!,
                {
                  level: 'SUCCESS',
                  message: `${hostResult.hostName}: upserted ${detection.signature.name}`,
                },
                progress,
              );
            }
          }
        }
      } else {
        await this.appendRunConsole(
          runId!,
          {
            level: 'WARN',
            message: 'Auto upsert is disabled; detections were not persisted.',
          },
          progress,
          { flush: true },
        );
      }

      const subnetResults: AgentSubnetScanResult[] = [];
      const uniqueSubnetProbedIps = new Set<string>();
      const uniqueSubnetReachableIps = new Set<string>();
      let subnetSummary:
        | {
            scannerAgents: number;
            cidrCount: number;
            hostsScanned: number;
            hostsReachable: number;
            detections: number;
            upserts: number;
            warnings: string[];
          }
        | undefined;
      if (this.shouldRunSubnetScan(subnetSettings)) {
        progress.stage = 'subnet-scan';
        const cidrs = subnetSettings.cidrs;
        await this.appendRunConsole(
          runId!,
          {
            level: 'INFO',
            message: `Subnet scan enabled for ${cidrs.length} CIDR(s)`,
          },
          progress,
          { flush: true },
        );
        if (cidrs.length > 0) {
          await this.appendRunConsole(
            runId!,
            {
              level: 'INFO',
              message: `Subnet CIDRs: ${cidrs.join(', ')}`,
            },
            progress,
            { flush: true },
          );
        }
        await this.appendRunConsole(
          runId!,
          {
            level: 'INFO',
            message: `Subnet settings: maxHosts=${subnetSettings.maxHosts}, concurrency=${subnetSettings.concurrency}, timeoutMs=${subnetSettings.connectTimeoutMs}, toolCallTimeoutMs=${subnetSettings.toolCallTimeoutMs}, includeAutoLocalCidrs=${subnetSettings.includeAutoLocalCidrs}, includeCommonWebPorts=${subnetSettings.includeCommonWebPorts}`,
          },
          progress,
          { flush: true },
        );

        if (cidrs.length === 0 && !subnetSettings.includeAutoLocalCidrs) {
          subnetSummary = {
            scannerAgents: 0,
            cidrCount: 0,
            hostsScanned: 0,
            hostsReachable: 0,
            detections: 0,
            upserts: 0,
            warnings: ['No subnet CIDRs configured for this run.'],
          };
          await this.appendRunConsole(
            runId!,
            {
              level: 'WARN',
              message: 'Subnet scan skipped because no CIDRs were configured.',
            },
            progress,
            { flush: true },
          );
        } else {
          for (const agent of selectedAgents) {
            if (!agent.hostId) {
              continue;
            }
            const hostName = agent.host?.hostname ?? 'unknown';
            await this.appendRunConsole(
              runId!,
              {
                level: 'INFO',
                message: `Host ${hostName}: scanning subnet CIDRs ${cidrs.join(', ')}`,
              },
              progress,
            );
            await this.appendRunConsole(
              runId!,
              {
                level: 'INFO',
                message: `${hostName}: starting subnet probe`,
              },
              progress,
            );
            const { subnetResult, failed: subnetScanFailed } =
              await this.discoverSubnetForAgentWithFallback({
                agentId: agent.id,
                hostId: agent.hostId,
                hostName,
                signatures: catalog.signatures,
                cidrs,
                settings: subnetSettings,
                runId: runId!,
                progress,
              });
            subnetResults.push(subnetResult);
            if (subnetScanFailed) {
              progress.errors += 1;
            }
            await this.appendSubnetProbeIpConsole(runId!, progress, hostName, subnetResult);
            progress.subnetIpsProbed += subnetResult.probedIps.length;
            for (const ip of subnetResult.probedIps) {
              uniqueSubnetProbedIps.add(ip.trim().toLowerCase());
            }
            for (const ip of subnetResult.reachableIps) {
              uniqueSubnetReachableIps.add(ip.trim().toLowerCase());
            }
            progress.subnetIpsUnique = uniqueSubnetProbedIps.size;
            progress.subnetIpsReachable = uniqueSubnetReachableIps.size;
            for (const detection of subnetResult.detections.slice(0, 20)) {
              await this.appendRunConsole(
                runId!,
                {
                  level: 'SUCCESS',
                  message: `${hostName}: subnet detection ${detection.serviceName} at ${detection.ip} (confidence ${Math.round(
                    detection.confidence * 100,
                  )}%, source ${detection.source})`,
                },
                progress,
              );
            }
            if (subnetResult.detections.length > 20) {
              await this.appendRunConsole(
                runId!,
                {
                  level: 'INFO',
                  message: `${hostName}: ${subnetResult.detections.length - 20} additional subnet detection(s) hidden to keep logs concise.`,
                },
                progress,
              );
            }
            progress.probes += subnetResult.hostsScanned;
            progress.detections += subnetResult.detections.length;
            await this.appendRunConsole(
              runId!,
              {
                level: 'INFO',
                message: `${hostName}: subnet scanned=${subnetResult.hostsScanned}, reachable=${subnetResult.hostsReachable}, detections=${subnetResult.detections.length}, probedIpTotal=${progress.subnetIpsProbed}, probedIpUnique=${progress.subnetIpsUnique}`,
              },
              progress,
              { flush: true },
            );
            if (subnetResult.hostsReachable > 0 && subnetResult.detections.length === 0) {
              await this.appendRunConsole(
                runId!,
                {
                  level: 'WARN',
                  message: subnetSettings.includeCommonWebPorts
                    ? `${hostName}: hosts were reachable but no signatures matched. Verify service ports/paths and signature probes.`
                    : `${hostName}: hosts were reachable but no signatures matched, and common web probes are disabled.`,
                },
                progress,
              );
            }
            if (subnetResult.hostsScanned > 0 && subnetResult.hostsReachable === 0) {
              await this.appendRunConsole(
                runId!,
                {
                  level: 'WARN',
                  message: `${hostName}: subnet scan reached 0/${subnetResult.hostsScanned} hosts. This usually indicates missing route/firewall access from the agent host to ${subnetResult.cidrs.join(', ')}.`,
                },
                progress,
                { flush: true },
              );
            }
            for (const warning of subnetResult.warnings) {
              await this.appendRunConsole(
                runId!,
                {
                  level: 'WARN',
                  message: `${hostName}: subnet warning - ${warning}`,
                },
                progress,
              );
            }
          }

          const subnetDetections = subnetResults.flatMap((result) => result.detections);
          const allowSubnetUpserts = autoUpsert;

          let subnetUpsertCount = 0;
          if (allowSubnetUpserts) {
            for (const result of subnetResults) {
              for (const detection of result.detections) {
                const created = await this.upsertSubnetDiscovery(
                  {
                    agentId: result.agentId,
                    hostId: result.hostId,
                    hostName: result.hostName,
                  },
                  detection,
                  {
                    actorUserId: params.triggeredByUserId,
                    runId: runId!,
                  },
                );
                subnetUpsertCount += created;
                if (created > 0) {
                  progress.upserts += created;
                  await this.appendRunConsole(
                    runId!,
                    {
                      level: 'SUCCESS',
                      message: `${result.hostName}: subnet upsert ${detection.serviceName} on ${detection.ip}`,
                    },
                    progress,
                  );
                }
              }
            }
          }

          const warningSet = new Set<string>();
          for (const result of subnetResults) {
            for (const warning of result.warnings) {
              const trimmed = warning.trim();
              if (trimmed.length > 0) {
                warningSet.add(trimmed);
              }
            }
          }
          if (!allowSubnetUpserts && subnetDetections.length > 0) {
            warningSet.add(
              'Subnet detections were not persisted because discovery auto-upsert is disabled.',
            );
            await this.appendRunConsole(
              runId!,
              {
                level: 'WARN',
                message:
                  'Subnet detections were not persisted because discovery auto-upsert is disabled.',
              },
              progress,
              { flush: true },
            );
          }

          subnetSummary = {
            scannerAgents: subnetResults.length,
            cidrCount: new Set(
              subnetResults.flatMap((result) => result.cidrs.map((cidr) => cidr.toLowerCase())),
            ).size,
            hostsScanned: subnetResults.reduce((total, result) => total + result.hostsScanned, 0),
            hostsReachable: subnetResults.reduce(
              (total, result) => total + result.hostsReachable,
              0,
            ),
            detections: subnetDetections.length,
            upserts: subnetUpsertCount,
            warnings: Array.from(warningSet.values()).slice(0, 50),
          };
          upsertCount += subnetUpsertCount;
          await this.appendRunConsole(
            runId!,
            {
              level: 'INFO',
              message: `Subnet IP totals: probed=${progress.subnetIpsProbed}, unique=${progress.subnetIpsUnique}, reachableUnique=${progress.subnetIpsReachable}`,
            },
            progress,
            { flush: true },
          );
        }
      } else {
        await this.appendRunConsole(
          runId!,
          {
            level: 'INFO',
            message: 'Subnet scan is disabled in Service Discovery Configuration.',
          },
          progress,
          { flush: true },
        );
      }

      const verificationSummary = await this.verifyDiscoveryEntities({
        runId: runId!,
        progress,
        selectedAgents,
        signatures: catalog.signatures,
      });

      const summary = discoveryRunSummarySchema.parse({
        hostCount: hostResults.length,
        probeCount: localProbeCount + (subnetSummary?.hostsScanned ?? 0),
        detectedCount: detections.length + (subnetSummary?.detections ?? 0),
        upsertCount,
        errors: errorCount,
        verification: verificationSummary,
        appliedConfig,
        subnet: subnetSummary,
      });
      progress.stage = 'finalizing';
      progress.probes = summary.probeCount;
      progress.detections = summary.detectedCount;
      progress.upserts = summary.upsertCount;
      progress.errors = summary.errors;
      await this.appendRunConsole(
        runId!,
        {
          level: 'SUCCESS',
          message: `Run completed: probes=${summary.probeCount}, detections=${summary.detectedCount}, upserts=${summary.upsertCount}`,
        },
        progress,
        { flush: true },
      );

      const finished = await this.prisma.serviceDiscoveryRun.update({
        where: { id: runId! },
        data: {
          finishedAt: new Date(),
          status: 'COMPLETED',
          hostCount: summary.hostCount,
          probeCount: summary.probeCount,
          detectedCount: summary.detectedCount,
          upsertCount: summary.upsertCount,
          errorCount: summary.errors,
          summary: {
            summary,
            hosts: hostResults.map((host) => ({
              hostId: host.hostId,
              hostName: host.hostName,
              detections: host.detections.map((detection) => ({
                signatureId: detection.signature.id,
                confidence: detection.confidence,
                endpoint: detection.endpoint,
                passive: detection.passive,
                probeEvidence: detection.probeEvidence,
              })),
              errors: host.errors,
            })),
            subnet: subnetResults.map((result) => ({
              agentId: result.agentId,
              hostId: result.hostId,
              hostName: result.hostName,
              cidrs: result.cidrs,
              hostsScanned: result.hostsScanned,
              hostsReachable: result.hostsReachable,
              detections: result.detections,
              warnings: result.warnings,
            })),
            progress,
            console: this.readRunConsolePayload(runId!),
          } as Prisma.InputJsonValue,
          error: null,
        },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          trigger: true,
          status: true,
          hostCount: true,
          probeCount: true,
          detectedCount: true,
          upsertCount: true,
          errorCount: true,
        },
      });

      await this.eventsService.emit({
        type: 'service.discovery.run',
        message: `Service discovery ${params.trigger.toLowerCase()} run completed`,
        payload: {
          runId: finished.id,
          trigger: finished.trigger,
          summary,
        } as Prisma.InputJsonValue,
      });

      await this.auditService.write({
        actorUserId: params.triggeredByUserId,
        action: 'service.discovery.run',
        targetType: 'service_discovery_run',
        targetId: finished.id,
        resultJson: {
          status: finished.status,
          summary,
        } as Prisma.InputJsonValue,
        success: true,
      });

      return serviceDiscoveryRunResponseSchema.parse({
        runId: finished.id,
        status: 'COMPLETED',
        startedAt: finished.startedAt.toISOString(),
        finishedAt: (finished.finishedAt ?? new Date()).toISOString(),
        trigger: finished.trigger,
        summary,
      });
    } catch (error) {
      if (!runRecord) {
        if (error instanceof Error) {
          throw error;
        }
        throw new InternalServerErrorException('Discovery run failed');
      }

      const message = error instanceof Error ? error.message : 'Discovery run failed';
      progress.stage = 'failed';
      progress.errors = Math.max(progress.errors, 1);
      await this.appendRunConsole(
        runId!,
        {
          level: 'ERROR',
          message: `Run failed: ${message}`,
        },
        progress,
        { flush: true },
      );
      const failed = await this.prisma.serviceDiscoveryRun.update({
        where: { id: runId! },
        data: {
          finishedAt: new Date(),
          status: 'FAILED',
          summary: {
            progress,
            console: this.readRunConsolePayload(runId!),
          } as Prisma.InputJsonValue,
          error: message,
        },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          trigger: true,
          hostCount: true,
          probeCount: true,
          detectedCount: true,
          upsertCount: true,
          errorCount: true,
        },
      });

      await this.auditService.write({
        actorUserId: params.triggeredByUserId,
        action: 'service.discovery.run',
        targetType: 'service_discovery_run',
        targetId: failed.id,
        resultJson: {
          error: message,
        } as Prisma.InputJsonValue,
        success: false,
      });

      throw new InternalServerErrorException('Service discovery run failed');
    } finally {
      if (runRecord) {
        this.clearRunConsole(runId!);
      }
      if (runId && this.activeRunId === runId) {
        this.activeRunId = null;
      }
      this.runActive = false;
    }
  }

  private async verifyDiscoveryEntities(input: {
    runId: string;
    progress: DiscoveryRunProgress;
    selectedAgents: Array<{
      id: string;
      hostId: string | null;
      host: {
        id: string;
        hostname: string;
        tags: unknown;
      } | null;
    }>;
    signatures: ServiceDiscoverySignature[];
  }): Promise<DiscoveryVerificationSummary> {
    const summary: DiscoveryVerificationSummary = {
      hostsChecked: 0,
      hostsUp: 0,
      hostsDown: 0,
      hostsSkipped: 0,
      servicesChecked: 0,
      servicesUp: 0,
      servicesDown: 0,
      servicesSkipped: 0,
      errors: 0,
    };
    input.progress.stage = 'verification';

    await this.appendRunConsole(
      input.runId,
      {
        level: 'INFO',
        message: 'Verification started for previously discovered services and hosts.',
      },
      input.progress,
      { flush: true },
    );

    const agentByHostId = new Map<string, string>();
    for (const agent of input.selectedAgents) {
      if (agent.hostId && !agentByHostId.has(agent.hostId)) {
        agentByHostId.set(agent.hostId, agent.id);
      }
    }

    const discoveryServices = await this.prisma.service.findMany({
      where: {
        OR: [
          {
            source: {
              startsWith: 'agent-discovery:',
            },
          },
          {
            source: {
              startsWith: 'subnet-discovery:',
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        source: true,
        instances: {
          select: {
            id: true,
            hostId: true,
            endpoint: true,
            metadata: true,
          },
        },
      },
    });

    const hostServiceVerification = new Map<
      string,
      { attempted: number; up: number; down: number }
    >();
    const serviceRollups = new Map<string, { checked: number; up: number; down: number }>();
    const selectedAgentIds = new Set(input.selectedAgents.map((agent) => agent.id));
    const now = new Date();

    for (const service of discoveryServices) {
      let serviceChecked = 0;
      let serviceUp = 0;
      let serviceDown = 0;

      for (const instance of service.instances) {
        const hostId = instance.hostId;
        if (!hostId) {
          summary.servicesSkipped += 1;
          continue;
        }
        let agentId = agentByHostId.get(hostId) ?? null;
        if (!agentId) {
          const sourceAgentId = extractDiscoverySourceAgentId(service.source);
          if (sourceAgentId && selectedAgentIds.has(sourceAgentId)) {
            agentId = sourceAgentId;
          }
        }
        if (!agentId && input.selectedAgents.length > 0) {
          agentId = input.selectedAgents[0]?.id ?? null;
        }
        if (!agentId) {
          summary.servicesSkipped += 1;
          continue;
        }

        const verification = await this.verifyDiscoveryServiceInstance({
          agentId,
          endpoint: instance.endpoint,
          serviceName: service.name,
          signatures: input.signatures,
        });

        const metadata = mergeDiscoveryVerificationMetadata(instance.metadata, {
          checkedAt: now.toISOString(),
          status: verification.status,
          endpoint: instance.endpoint,
          reason: verification.reason,
        });

        if (verification.status === 'skipped') {
          summary.servicesSkipped += 1;
          await this.prisma.serviceInstance.update({
            where: { id: instance.id },
            data: {
              metadata: metadata as Prisma.InputJsonValue,
            },
          });
          continue;
        }

        summary.servicesChecked += 1;
        serviceChecked += 1;
        const hostSummary = hostServiceVerification.get(hostId) ?? { attempted: 0, up: 0, down: 0 };
        hostSummary.attempted += 1;

        if (verification.status === 'up') {
          summary.servicesUp += 1;
          serviceUp += 1;
          hostSummary.up += 1;
          await this.prisma.serviceInstance.update({
            where: { id: instance.id },
            data: {
              status: 'OK',
              lastSeenAt: now,
              metadata: metadata as Prisma.InputJsonValue,
            },
          });
        } else {
          summary.servicesDown += 1;
          serviceDown += 1;
          hostSummary.down += 1;
          await this.prisma.serviceInstance.update({
            where: { id: instance.id },
            data: {
              status: 'WARN',
              metadata: metadata as Prisma.InputJsonValue,
            },
          });
        }

        hostServiceVerification.set(hostId, hostSummary);
      }

      if (serviceChecked > 0) {
        serviceRollups.set(service.id, {
          checked: serviceChecked,
          up: serviceUp,
          down: serviceDown,
        });
      }
    }

    for (const [serviceId, rollup] of serviceRollups.entries()) {
      await this.prisma.service.update({
        where: { id: serviceId },
        data: {
          status: rollup.down > 0 ? 'WARN' : 'OK',
        },
      });
    }

    const hostIds = new Set<string>();
    for (const hostId of hostServiceVerification.keys()) {
      hostIds.add(hostId);
    }

    const hostWhereClauses: Prisma.HostWhereInput[] = [
      {
        tags: {
          has: 'discovered',
        },
      },
      {
        tags: {
          has: 'subnet',
        },
      },
    ];
    if (hostIds.size > 0) {
      hostWhereClauses.unshift({
        id: {
          in: Array.from(hostIds.values()),
        },
      });
    }

    const taggedHosts = await this.prisma.host.findMany({
      where: {
        OR: hostWhereClauses,
      },
      select: {
        id: true,
        hostname: true,
      },
    });

    for (const host of taggedHosts) {
      const agentId = agentByHostId.get(host.id);
      if (agentId) {
        try {
          await this.callReadTool(agentId, 'host.status', {});
          summary.hostsChecked += 1;
          summary.hostsUp += 1;
          await this.prisma.host.update({
            where: { id: host.id },
            data: {
              status: 'OK',
              lastSeenAt: now,
            },
          });
          continue;
        } catch {
          summary.hostsChecked += 1;
          summary.hostsDown += 1;
          summary.errors += 1;
          await this.prisma.host.update({
            where: { id: host.id },
            data: {
              status: 'WARN',
            },
          });
          continue;
        }
      }

      const hostVerification = hostServiceVerification.get(host.id);
      if (!hostVerification || hostVerification.attempted === 0) {
        summary.hostsSkipped += 1;
        continue;
      }

      summary.hostsChecked += 1;
      if (hostVerification.up > 0) {
        summary.hostsUp += 1;
        await this.prisma.host.update({
          where: { id: host.id },
          data: {
            status: 'OK',
            lastSeenAt: now,
          },
        });
      } else {
        summary.hostsDown += 1;
        await this.prisma.host.update({
          where: { id: host.id },
          data: {
            status: 'WARN',
          },
        });
      }
    }

    await this.appendRunConsole(
      input.runId,
      {
        level: 'INFO',
        message: `Verification finished: hosts checked=${summary.hostsChecked}, up=${summary.hostsUp}, down=${summary.hostsDown}, services checked=${summary.servicesChecked}, up=${summary.servicesUp}, down=${summary.servicesDown}.`,
      },
      input.progress,
      { flush: true },
    );

    return summary;
  }

  private async verifyDiscoveryServiceInstance(input: {
    agentId: string;
    endpoint: string | null;
    serviceName: string;
    signatures: ServiceDiscoverySignature[];
  }): Promise<{ status: 'up' | 'down' | 'skipped'; reason?: string }> {
    const parsedEndpointProbe = toProbeFromEndpoint(input.endpoint);
    if (parsedEndpointProbe) {
      const probeResult = await this.executeProbe(input.agentId, parsedEndpointProbe);
      return {
        status: probeResult.matched ? 'up' : 'down',
        reason: probeResult.matched ? 'endpoint_probe_matched' : 'endpoint_probe_failed',
      };
    }

    const signature = input.signatures.find(
      (candidate) => candidate.name.toLowerCase() === input.serviceName.toLowerCase(),
    );
    if (!signature) {
      return {
        status: 'skipped',
        reason: 'no_signature_or_endpoint',
      };
    }

    for (const probe of flattenProbeTemplates(signature.probes).slice(0, 6)) {
      const probeResult = await this.executeProbe(input.agentId, probe);
      if (probeResult.matched) {
        return {
          status: 'up',
          reason: 'signature_probe_matched',
        };
      }
      if (probeResult.reachable) {
        return {
          status: 'down',
          reason: 'signature_probe_reachable_no_match',
        };
      }
    }

    return {
      status: 'down',
      reason: 'signature_probe_failed',
    };
  }

  /**
   * Loads target agents.
   */
  private async loadTargetAgents(hostId?: string) {
    const where: Prisma.AgentWhereInput = {
      status: 'ONLINE',
      revokedAt: null,
      host: {
        isNot: null,
      },
    };
    if (hostId) {
      where.hostId = hostId;
    }

    const agents = await this.prisma.agent.findMany({
      where,
      include: {
        host: {
          select: {
            id: true,
            hostname: true,
            tags: true,
          },
        },
      },
      orderBy: {
        lastSeenAt: 'desc',
      },
    });

    if (hostId && agents.length === 0) {
      throw new NotFoundException('No online agent is enrolled for the selected host');
    }

    return agents;
  }

  private async discoverForHost(input: {
    agentId: string;
    hostId: string;
    hostName: string;
    signatures: ServiceDiscoverySignature[];
    confidenceThreshold: number;
    onProbeResult?: (event: {
      hostName: string;
      signatureId: string;
      signatureName: string;
      probe: {
        protocol: 'http' | 'https' | 'tcp';
        port: number;
        path?: string;
      };
      result: ProbeResult;
    }) => Promise<void>;
    onDetection?: (event: {
      hostName: string;
      signatureId: string;
      signatureName: string;
      confidence: number;
      endpoint: string | null;
    }) => Promise<void>;
    onError?: (message: string) => Promise<void>;
  }): Promise<HostDiscoveryResult> {
    const response = await Promise.allSettled([
      this.callReadTool(input.agentId, 'host.status', {}),
      this.callReadTool(input.agentId, 'services.list', {}),
      this.callReadTool(input.agentId, 'containers.list', {}),
      this.callReadTool(input.agentId, 'process.snapshot', { limit: 250 }),
    ]);

    const hostStatus = settledValue(response[0]);
    const servicesList = settledValue(response[1]);
    const containersList = settledValue(response[2]);
    const processSnapshot = settledValue(response[3]);

    const errors: string[] = [];
    for (const entry of response) {
      if (entry.status === 'rejected') {
        const message = entry.reason instanceof Error ? entry.reason.message : 'tool call failed';
        errors.push(message);
        await input.onError?.(message);
      }
    }

    const passiveEvidence = this.collectPassiveEvidence({
      hostStatus,
      servicesList,
      containersList,
      processSnapshot,
    });

    const detections: HostDiscoveryResult['detections'] = [];
    let probeCount = 0;
    const maxProbesPerHost = this.configService.get<number>('DISCOVERY_MAX_PROBES_PER_HOST', 12);

    for (const signature of input.signatures) {
      const passive = evaluatePassive(signature, passiveEvidence);
      const probeEvidence = { attempted: 0, matched: 0 };
      let endpoint: string | null = null;

      const passiveScoreOnly = computeDiscoveryScore({
        passive,
        probe: probeEvidence,
      }).passiveScore;

      if (passiveScoreOnly < 0.2) {
        continue;
      }

      for (const probe of flattenProbeTemplates(signature.probes)) {
        if (probeCount >= maxProbesPerHost) {
          break;
        }
        probeCount += 1;
        probeEvidence.attempted += 1;
        const probeResult = await this.executeProbe(input.agentId, probe);
        await input.onProbeResult?.({
          hostName: input.hostName,
          signatureId: signature.id,
          signatureName: signature.name,
          probe: {
            protocol: probe.protocol,
            port: probe.port,
            path: probe.path,
          },
          result: probeResult,
        });
        if (probeResult.matched) {
          probeEvidence.matched += 1;
          if (!endpoint) {
            endpoint = probeResult.endpoint;
          }
        }
      }

      const scored = computeDiscoveryScore({
        passive,
        probe: probeEvidence,
      });

      if (scored.confidence < input.confidenceThreshold) {
        continue;
      }

      detections.push({
        signature,
        passive,
        confidence: scored.confidence,
        endpoint,
        probeEvidence,
      });
      await input.onDetection?.({
        hostName: input.hostName,
        signatureId: signature.id,
        signatureName: signature.name,
        confidence: scored.confidence,
        endpoint,
      });
    }

    return {
      hostId: input.hostId,
      hostName: input.hostName,
      probeCount,
      detections,
      errors,
    };
  }

  private async executeProbe(
    agentId: string,
    probe: {
      protocol: 'http' | 'https' | 'tcp';
      port: number;
      path?: string;
      statusCodes?: number[];
      bodyContains?: string[];
      headersContain?: string[];
    },
  ): Promise<ProbeResult> {
    try {
      const raw = await this.callReadTool(agentId, 'service.probe', {
        protocol: probe.protocol,
        port: probe.port,
        path: probe.path,
        timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
        expect: {
          statusCodes: probe.statusCodes,
          bodyContains: probe.bodyContains,
          headersContain: probe.headersContain,
        },
      });

      const ok = Boolean(raw?.ok);
      const reachable = Boolean(raw?.reachable);
      const endpoint =
        typeof raw?.url === 'string'
          ? raw.url
          : probe.protocol === 'tcp'
            ? `${probe.protocol}://127.0.0.1:${probe.port}`
            : `${probe.protocol}://127.0.0.1:${probe.port}${probe.path ?? '/'}`;

      return {
        matched: ok,
        reachable,
        endpoint,
        details: toRecord(raw),
      };
    } catch {
      return {
        matched: false,
        reachable: false,
        endpoint: null,
        details: {},
      };
    }
  }

  private async callReadTool(
    agentId: string,
    toolName: string,
    toolParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const raw = await this.mcpService.callTool({
      agentId,
      toolName,
      toolParams,
    });
    return toRecord(raw.result);
  }

  private buildSubnetScanToolParams(input: {
    signatures: ServiceDiscoverySignature[];
    cidrs: string[];
    settings: {
      includeAutoLocalCidrs: boolean;
      includeCommonWebPorts: boolean;
      maxHosts: number;
      concurrency: number;
      connectTimeoutMs: number;
      toolCallTimeoutMs: number;
    };
  }) {
    return {
      cidrs: input.cidrs,
      includeAutoLocalCidrs: input.settings.includeAutoLocalCidrs,
      includeCommonWebPorts: input.settings.includeCommonWebPorts,
      maxHosts: input.settings.maxHosts,
      concurrency: input.settings.concurrency,
      connectTimeoutMs: input.settings.connectTimeoutMs,
      toolCallTimeoutMs: input.settings.toolCallTimeoutMs,
      signatures: input.signatures.map((signature) => ({
        id: signature.id,
        name: signature.name,
        tags: signature.tags,
        probes: signature.probes,
      })),
    };
  }

  private parseSubnetScanJobStatus(
    jobId: string,
    raw: Record<string, unknown>,
  ): AgentSubnetScanJobStatus {
    const progress = toRecord(raw.progress);
    const rawState =
      readString(raw, ['state']) ??
      readString(raw, ['status']) ??
      readString(progress, ['state']) ??
      'RUNNING';
    const normalizedState = rawState.trim().toUpperCase();
    const state: AgentSubnetScanJobState =
      normalizedState === 'COMPLETED'
        ? 'COMPLETED'
        : normalizedState === 'FAILED'
          ? 'FAILED'
          : 'RUNNING';

    const warnings = [...readStringArray(raw.warnings), ...readStringArray(progress?.warnings)]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 50);

    const error =
      readString(raw, ['error']) ??
      readString(raw, ['message']) ??
      readString(progress, ['error']) ??
      null;

    return {
      jobId:
        readString(raw, ['jobId']) ??
        readString(raw, ['scanJobId']) ??
        readString(progress, ['jobId']) ??
        jobId,
      state,
      error,
      hostsScanned: Math.max(
        0,
        Math.round(
          readNumber(raw, ['hostsScanned']) ?? readNumber(progress, ['hostsScanned']) ?? 0,
        ),
      ),
      hostsReachable: Math.max(
        0,
        Math.round(
          readNumber(raw, ['hostsReachable']) ?? readNumber(progress, ['hostsReachable']) ?? 0,
        ),
      ),
      detections: Math.max(
        0,
        Math.round(readNumber(raw, ['detections']) ?? readNumber(progress, ['detections']) ?? 0),
      ),
      warnings,
    };
  }

  /**
   * Handles read subnet scan result payload.
   */
  private readSubnetScanResultPayload(raw: Record<string, unknown>) {
    const nestedResult = raw.result;
    if (nestedResult && typeof nestedResult === 'object' && !Array.isArray(nestedResult)) {
      return toRecord(nestedResult);
    }
    const scanResult = raw.scanResult;
    if (scanResult && typeof scanResult === 'object' && !Array.isArray(scanResult)) {
      return toRecord(scanResult);
    }
    const scan = raw.scan;
    if (scan && typeof scan === 'object' && !Array.isArray(scan)) {
      return toRecord(scan);
    }
    return raw;
  }

  /**
   * Checks whether run subnet scan.
   */
  private shouldRunSubnetScan(config: DiscoverySubnetConfig) {
    return config.enabled;
  }

  /**
   * Builds default discovery config for the surrounding workflow.
   */
  private buildDefaultDiscoveryConfig(): DiscoverySubnetConfig {
    const envCidrs = normalizeCidrList(
      this.configService
        .get<string>('DISCOVERY_SUBNET_DEFAULT_CIDRS', '')
        .split(',')
        .map((entry) => entry.trim()),
    );

    return {
      enabled: this.configService.get<boolean>('DISCOVERY_SUBNET_ENABLED', false),
      cidrs: envCidrs.length > 0 ? envCidrs : DEFAULT_SUBNET_CIDRS.slice(),
      includeAutoLocalCidrs: false,
      includeCommonWebPorts: true,
      maxHosts: clampNumber(
        this.configService.get<number>('DISCOVERY_SUBNET_MAX_HOSTS', 512),
        512,
        1,
        4096,
      ),
      concurrency: clampNumber(
        this.configService.get<number>('DISCOVERY_SUBNET_CONCURRENCY', 24),
        24,
        1,
        128,
      ),
      connectTimeoutMs: clampNumber(
        this.configService.get<number>('DISCOVERY_SUBNET_CONNECT_TIMEOUT_MS', 750),
        750,
        100,
        10_000,
      ),
      toolCallTimeoutMs: clampNumber(
        this.configService.get<number>('DISCOVERY_SUBNET_MCP_TOOL_TIMEOUT_MS', 120_000),
        120_000,
        5_000,
        600_000,
      ),
    };
  }

  /**
   * Normalizes discovery config before the caller uses it.
   */
  private normalizeDiscoveryConfig(config: ServiceDiscoveryConfig): DiscoverySubnetConfig {
    const defaults = this.buildDefaultDiscoveryConfig();
    return {
      enabled: config.enabled,
      cidrs: normalizeCidrList(config.cidrs),
      includeAutoLocalCidrs: config.includeAutoLocalCidrs,
      includeCommonWebPorts: config.includeCommonWebPorts,
      maxHosts: clampNumber(config.maxHosts, defaults.maxHosts, 1, 4096),
      concurrency: clampNumber(config.concurrency, defaults.concurrency, 1, 128),
      connectTimeoutMs: clampNumber(
        config.connectTimeoutMs,
        defaults.connectTimeoutMs,
        100,
        10_000,
      ),
      toolCallTimeoutMs: clampNumber(
        config.toolCallTimeoutMs,
        defaults.toolCallTimeoutMs,
        5_000,
        600_000,
      ),
    };
  }

  /**
   * Implements the read discovery config workflow for this file.
   */
  private async readDiscoveryConfig(): Promise<{
    config: DiscoverySubnetConfig;
    updatedAt: string;
  }> {
    const existing = await this.getConfigStore().findUnique({
      where: {
        id: DISCOVERY_CONFIG_ID,
      },
      select: {
        subnetEnabled: true,
        subnetCidrs: true,
        includeAutoLocalCidrs: true,
        includeCommonWebPorts: true,
        subnetMaxHosts: true,
        subnetConcurrency: true,
        subnetConnectTimeoutMs: true,
        subnetToolCallTimeoutMs: true,
        updatedAt: true,
      },
    });

    if (!existing) {
      return {
        config: this.buildDefaultDiscoveryConfig(),
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      config: this.normalizeDiscoveryConfig({
        enabled: existing.subnetEnabled,
        cidrs: existing.subnetCidrs,
        includeAutoLocalCidrs: existing.includeAutoLocalCidrs,
        includeCommonWebPorts: existing.includeCommonWebPorts,
        maxHosts: existing.subnetMaxHosts,
        concurrency: existing.subnetConcurrency,
        connectTimeoutMs: existing.subnetConnectTimeoutMs,
        toolCallTimeoutMs: existing.subnetToolCallTimeoutMs,
      }),
      updatedAt: existing.updatedAt.toISOString(),
    };
  }

  private async discoverSubnetForAgent(input: {
    agentId: string;
    hostId: string;
    hostName: string;
    signatures: ServiceDiscoverySignature[];
    cidrs: string[];
    settings: {
      includeAutoLocalCidrs: boolean;
      includeCommonWebPorts: boolean;
      maxHosts: number;
      concurrency: number;
      connectTimeoutMs: number;
      toolCallTimeoutMs: number;
    };
  }): Promise<AgentSubnetScanResult> {
    const toolParams = this.buildSubnetScanToolParams(input);
    const started = await this.callReadTool(input.agentId, SUBNET_SCAN_TOOL_START, toolParams);
    const jobId =
      readString(started, ['jobId']) ??
      readString(started, ['scanJobId']) ??
      readString(started, ['id']);
    if (!jobId) {
      throw new Error('Agent did not return a subnet scan job id');
    }

    const deadlineAtMs =
      Date.now() + input.settings.toolCallTimeoutMs + SUBNET_SCAN_RESULT_GRACE_MS;
    while (true) {
      const statusRaw = await this.callReadTool(input.agentId, SUBNET_SCAN_TOOL_STATUS, { jobId });
      const status = this.parseSubnetScanJobStatus(jobId, statusRaw);
      if (status.state === 'FAILED') {
        const reason =
          status.error ??
          status.warnings[0] ??
          'Subnet scan failed before the agent returned results';
        throw new Error(reason);
      }
      if (status.state === 'COMPLETED') {
        break;
      }
      if (Date.now() >= deadlineAtMs) {
        throw new Error(
          'Subnet scan timed out before the agent returned results. Reduce scan scope or increase toolCallTimeoutMs.',
        );
      }
      await delay(SUBNET_SCAN_STATUS_POLL_MS);
    }

    const raw = this.readSubnetScanResultPayload(
      await this.callReadTool(input.agentId, SUBNET_SCAN_TOOL_RESULT, { jobId }),
    );

    const cidrs = Array.isArray(raw.cidrs)
      ? raw.cidrs.filter((entry): entry is string => typeof entry === 'string')
      : input.cidrs;
    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .slice(0, 50)
      : [];
    const probedIps = parseIpList(raw.probedIps, 4096);
    const reachableIps = parseIpList(raw.reachableIps, 4096);
    const detectionsRaw = Array.isArray(raw.detections) ? raw.detections : [];
    const detections: SubnetScanDetection[] = [];
    const seen = new Set<string>();
    for (const entry of detectionsRaw) {
      const record = toRecord(entry);
      const ip = readString(record, ['ip']) ?? null;
      const serviceName = readString(record, ['serviceName']) ?? null;
      if (!ip || !serviceName) {
        continue;
      }
      const endpoint = readString(record, ['endpoint']) ?? null;
      const source = readString(record, ['source']) === 'common-web' ? 'common-web' : 'signature';
      const serviceId =
        readString(record, ['serviceId']) ??
        serviceName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
      const confidence = clampFloat(readNumber(record, ['confidence']) ?? 0.5, 0, 1);
      const tags = Array.isArray(record.tags)
        ? record.tags
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length > 0)
        : [];
      const dedupeKey = `${ip.toLowerCase()}|${serviceId.toLowerCase()}|${(endpoint ?? '').toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      detections.push({
        ip,
        hostname: readString(record, ['hostname']) ?? null,
        serviceId: serviceId.length > 0 ? serviceId : 'unknown',
        serviceName,
        endpoint,
        confidence,
        source,
        tags,
        evidence: toRecord(record.evidence),
      });
    }

    return {
      agentId: input.agentId,
      hostId: input.hostId,
      hostName: input.hostName,
      cidrs: normalizeCidrList(cidrs),
      hostsScanned: Math.max(0, Math.round(readNumber(raw, ['hostsScanned']) ?? 0)),
      hostsReachable: Math.max(0, Math.round(readNumber(raw, ['hostsReachable']) ?? 0)),
      probedIps,
      reachableIps,
      detections,
      warnings,
    };
  }

  private async discoverSubnetForAgentWithFallback(input: {
    runId: string;
    progress: DiscoveryRunProgress;
    agentId: string;
    hostId: string;
    hostName: string;
    signatures: ServiceDiscoverySignature[];
    cidrs: string[];
    settings: {
      includeAutoLocalCidrs: boolean;
      includeCommonWebPorts: boolean;
      maxHosts: number;
      concurrency: number;
      connectTimeoutMs: number;
      toolCallTimeoutMs: number;
    };
  }) {
    try {
      const subnetResult = await this.discoverSubnetForAgent(input);
      return {
        subnetResult,
        failed: false,
      };
    } catch (error) {
      const message = sanitizeConsoleMessage(
        error instanceof Error ? error.message : 'Unknown subnet scan error',
      );
      await this.appendRunConsole(
        input.runId,
        {
          level: 'ERROR',
          message: `${input.hostName}: subnet scan failed - ${message}`,
        },
        input.progress,
      );
      return {
        subnetResult: {
          agentId: input.agentId,
          hostId: input.hostId,
          hostName: input.hostName,
          cidrs: input.cidrs,
          hostsScanned: 0,
          hostsReachable: 0,
          probedIps: [],
          reachableIps: [],
          detections: [],
          warnings: [sanitizeConsoleMessage(`Subnet scan failed: ${message}`)],
        },
        failed: true,
      };
    }
  }

  private async appendSubnetProbeIpConsole(
    runId: string,
    progress: DiscoveryRunProgress,
    hostName: string,
    subnetResult: AgentSubnetScanResult,
  ) {
    if (subnetResult.probedIps.length === 0) {
      return;
    }

    const chunkSize = 10;
    const maxProbedIpsForConsole = 120;
    const maxReachableIpsForConsole = 60;
    const probedVisible = subnetResult.probedIps.slice(0, maxProbedIpsForConsole);
    await this.appendRunConsole(
      runId,
      {
        level: 'INFO',
        message: `${hostName}: probed ${subnetResult.probedIps.length} IP(s).`,
      },
      progress,
    );
    for (let index = 0; index < probedVisible.length; index += chunkSize) {
      const chunk = probedVisible.slice(index, index + chunkSize);
      await this.appendRunConsole(
        runId,
        {
          level: 'INFO',
          message: `${hostName}: probed IPs ${index + 1}-${index + chunk.length}: ${chunk.join(', ')}`,
        },
        progress,
      );
    }
    if (subnetResult.probedIps.length > probedVisible.length) {
      await this.appendRunConsole(
        runId,
        {
          level: 'INFO',
          message: `${hostName}: ${subnetResult.probedIps.length - probedVisible.length} additional probed IP(s) omitted from console output.`,
        },
        progress,
      );
    }

    if (subnetResult.reachableIps.length === 0) {
      return;
    }
    const reachableVisible = subnetResult.reachableIps.slice(0, maxReachableIpsForConsole);
    await this.appendRunConsole(
      runId,
      {
        level: 'INFO',
        message: `${hostName}: reachable IPs ${subnetResult.reachableIps.length}.`,
      },
      progress,
    );
    for (let index = 0; index < reachableVisible.length; index += chunkSize) {
      const chunk = reachableVisible.slice(index, index + chunkSize);
      await this.appendRunConsole(
        runId,
        {
          level: 'INFO',
          message: `${hostName}: reachable IPs ${index + 1}-${index + chunk.length}: ${chunk.join(', ')}`,
        },
        progress,
      );
    }
    if (subnetResult.reachableIps.length > reachableVisible.length) {
      await this.appendRunConsole(
        runId,
        {
          level: 'INFO',
          message: `${hostName}: ${subnetResult.reachableIps.length - reachableVisible.length} additional reachable IP(s) omitted from console output.`,
        },
        progress,
      );
    }
  }

  private collectPassiveEvidence(input: {
    hostStatus: Record<string, unknown>;
    servicesList: Record<string, unknown>;
    containersList: Record<string, unknown>;
    processSnapshot: Record<string, unknown>;
  }) {
    const serviceCandidates = [
      ...(readArray(input.hostStatus, ['services']) ?? []),
      ...(readArray(input.servicesList, ['services']) ?? []),
    ];
    const systemdNames = serviceCandidates
      .map((entry) => readString(toRecord(entry), ['name']))
      .filter((value): value is string => Boolean(value));

    const containerCandidates = readArray(input.containersList, ['containers']) ?? [];
    const containerTexts = containerCandidates
      .flatMap((entry) => {
        const record = toRecord(entry);
        return [readString(record, ['name']), readString(record, ['image'])];
      })
      .filter((value): value is string => Boolean(value));

    const processCandidates = readArray(input.processSnapshot, ['processes']) ?? [];
    const processTexts = processCandidates
      .flatMap((entry) => {
        const record = toRecord(entry);
        return [readString(record, ['name']), readString(record, ['command'])];
      })
      .filter((value): value is string => Boolean(value));

    return {
      systemdNames,
      containerTexts,
      processTexts,
    };
  }

  private async upsertDiscovery(
    host: {
      agentId: string | null;
      hostId: string;
      hostName: string;
    },
    detection: HostDiscoveryResult['detections'][number],
    context: {
      actorUserId?: string;
      runId: string;
    },
  ) {
    const source = `agent-discovery:${host.agentId ?? 'unknown'}`;

    const upserted = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const service = await tx.service.upsert({
        where: {
          name_source: {
            name: detection.signature.name,
            source,
          },
        },
        update: {
          status: 'OK',
          tags: detection.signature.tags,
        },
        create: {
          name: detection.signature.name,
          source,
          status: 'OK',
          tags: detection.signature.tags,
        },
      });

      const instanceName = `${detection.signature.name}@${host.hostName}`;
      const existing = await tx.serviceInstance.findUnique({
        where: {
          serviceId_hostId_name: {
            serviceId: service.id,
            hostId: host.hostId,
            name: instanceName,
          },
        },
        select: {
          metadata: true,
        },
      });

      const mergedMetadata = {
        ...toRecord(existing?.metadata),
        discovery: {
          signatureId: detection.signature.id,
          confidence: detection.confidence,
          evidence: {
            passive: detection.passive,
            probes: detection.probeEvidence,
          },
          detectedAt: new Date().toISOString(),
        },
      };

      await tx.serviceInstance.upsert({
        where: {
          serviceId_hostId_name: {
            serviceId: service.id,
            hostId: host.hostId,
            name: instanceName,
          },
        },
        update: {
          status: 'OK',
          endpoint: detection.endpoint,
          metadata: mergedMetadata as Prisma.InputJsonValue,
          lastSeenAt: new Date(),
          hostId: host.hostId,
        },
        create: {
          serviceId: service.id,
          hostId: host.hostId,
          name: instanceName,
          status: 'OK',
          endpoint: detection.endpoint,
          metadata: mergedMetadata as Prisma.InputJsonValue,
          lastSeenAt: new Date(),
        },
      });

      return {
        serviceId: service.id,
        instanceName,
      };
    });

    await this.auditService.write({
      actorUserId: context.actorUserId,
      action: 'service.discovery.upsert',
      targetType: 'service',
      targetId: upserted.serviceId,
      paramsJson: {
        runId: context.runId,
        hostId: host.hostId,
        source,
        signatureId: detection.signature.id,
        confidence: detection.confidence,
        instanceName: upserted.instanceName,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return 1;
  }

  private async upsertSubnetDiscovery(
    host: {
      agentId: string | null;
      hostId: string;
      hostName: string;
    },
    detection: SubnetScanDetection,
    context: {
      actorUserId?: string;
      runId: string;
    },
  ) {
    const source = `subnet-discovery:${host.agentId ?? 'unknown'}`;
    const resolvedPrimaryIp = normalizePrimaryIp(detection.ip);
    const discoveredHostname = normalizeHostName(detection.hostname);
    const preferredHostName = discoveredHostname ?? resolvedPrimaryIp ?? detection.ip.trim();

    const upserted = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingHost = await resolveCanonicalHostByIdentity(
        tx,
        this.auditService,
        {
          hostname: discoveredHostname ?? resolvedPrimaryIp,
          primaryIp: resolvedPrimaryIp,
        },
        {
          actorUserId: context.actorUserId,
          primaryIp: resolvedPrimaryIp,
        },
      );

      const shouldRenameHost =
        Boolean(discoveredHostname) &&
        existingHost &&
        isIpLikeHostname(existingHost.hostname) &&
        !isIpLikeHostname(discoveredHostname!) &&
        existingHost.hostname.localeCompare(discoveredHostname!, undefined, {
          sensitivity: 'accent',
        }) !== 0;

      const hostName = existingHost
        ? shouldRenameHost
          ? discoveredHostname!
          : existingHost.hostname
        : preferredHostName;

      let discoveredHost: {
        id: string;
        hostname: string;
        tags: string[];
      } | null = null;

      if (existingHost) {
        discoveredHost = await tx.host.update({
          where: {
            id: existingHost.id,
          },
          data: {
            hostname: hostName,
            lastSeenAt: new Date(),
            status: 'UNKNOWN',
            tags: mergeStringLists(existingHost.tags, ['discovered', 'subnet', ...detection.tags]),
          },
          select: {
            id: true,
            hostname: true,
            tags: true,
          },
        });
        if (shouldRenameHost) {
          await normalizeServiceInstancesForHost(tx, discoveredHost.id, discoveredHost.hostname);
        }
      } else {
        discoveredHost = await tx.host.create({
          data: {
            hostname: hostName,
            tags: mergeStringLists([], ['discovered', 'subnet', ...detection.tags]),
            status: 'UNKNOWN',
            lastSeenAt: new Date(),
          },
          select: {
            id: true,
            hostname: true,
            tags: true,
          },
        });
      }

      await tx.hostFact.create({
        data: {
          hostId: discoveredHost.id,
          snapshot: {
            hostname: discoveredHost.hostname,
            network: {
              primaryIp: resolvedPrimaryIp ?? detection.ip,
            },
            discovery: {
              source: 'subnet',
              runId: context.runId,
              byAgentId: host.agentId,
              serviceId: detection.serviceId,
              serviceName: detection.serviceName,
              endpoint: detection.endpoint,
              confidence: detection.confidence,
              seenAt: new Date().toISOString(),
            },
          } as Prisma.InputJsonValue,
        },
      });

      const service = await tx.service.upsert({
        where: {
          name_source: {
            name: detection.serviceName,
            source,
          },
        },
        update: {
          status: 'OK',
          tags: mergeStringLists(detection.tags, ['subnet']),
        },
        create: {
          name: detection.serviceName,
          source,
          status: 'OK',
          tags: mergeStringLists(detection.tags, ['subnet']),
        },
      });

      const instanceName = `${detection.serviceName}@${discoveredHost.hostname}`;
      const existing = await tx.serviceInstance.findUnique({
        where: {
          serviceId_hostId_name: {
            serviceId: service.id,
            hostId: discoveredHost.id,
            name: instanceName,
          },
        },
        select: {
          metadata: true,
        },
      });

      const mergedMetadata = {
        ...toRecord(existing?.metadata),
        discovery: {
          mode: 'subnet',
          runId: context.runId,
          ip: resolvedPrimaryIp ?? detection.ip,
          source: detection.source,
          confidence: detection.confidence,
          evidence: detection.evidence,
          seenAt: new Date().toISOString(),
        },
      };

      await tx.serviceInstance.upsert({
        where: {
          serviceId_hostId_name: {
            serviceId: service.id,
            hostId: discoveredHost.id,
            name: instanceName,
          },
        },
        update: {
          status: 'OK',
          endpoint: detection.endpoint,
          metadata: mergedMetadata as Prisma.InputJsonValue,
          lastSeenAt: new Date(),
          hostId: discoveredHost.id,
        },
        create: {
          serviceId: service.id,
          hostId: discoveredHost.id,
          name: instanceName,
          status: 'OK',
          endpoint: detection.endpoint,
          metadata: mergedMetadata as Prisma.InputJsonValue,
          lastSeenAt: new Date(),
        },
      });

      return {
        serviceId: service.id,
        hostId: discoveredHost.id,
        hostName: discoveredHost.hostname,
        instanceName,
      };
    });

    await this.auditService.write({
      actorUserId: context.actorUserId,
      action: 'service.discovery.subnet.upsert',
      targetType: 'service',
      targetId: upserted.serviceId,
      paramsJson: {
        runId: context.runId,
        source,
        scannerHostId: host.hostId,
        scannerHostName: host.hostName,
        discoveredHostId: upserted.hostId,
        discoveredHostName: upserted.hostName,
        ip: detection.ip,
        serviceId: detection.serviceId,
        serviceName: detection.serviceName,
        confidence: detection.confidence,
        instanceName: upserted.instanceName,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return 1;
  }

  /**
   * Loads effective catalog for the surrounding workflow.
   */
  private async loadEffectiveCatalog(): Promise<{
    signatures: ServiceDiscoverySignature[];
    source: 'BUILTIN' | 'HYBRID';
    expiresAt: Date;
    lastError: string | null;
  }> {
    const aiEnabled = this.configService.get<boolean>('DISCOVERY_AI_ENABLED', true);
    const ttlSec = this.configService.get<number>('DISCOVERY_AI_CATALOG_TTL_SEC', 86_400);
    const openai = await this.aiProviderService.getClient();

    if (!aiEnabled || !openai) {
      return {
        signatures: BUILTIN_DISCOVERY_SIGNATURES,
        source: 'BUILTIN',
        expiresAt: new Date(Date.now() + ttlSec * 1_000),
        lastError: aiEnabled ? 'OpenAI unavailable' : null,
      };
    }

    const existing = await this.prisma.serviceDiscoveryCatalog.findUnique({
      where: { id: DISCOVERY_CATALOG_ID },
    });

    if (existing && existing.expiresAt > new Date()) {
      const parsed = aiCatalogEnvelopeSchema.safeParse(existing.entries);
      if (parsed.success) {
        const merged = mergeServiceDiscoverySignatures(
          BUILTIN_DISCOVERY_SIGNATURES,
          parsed.data.services,
        );
        return {
          signatures: merged,
          source: 'HYBRID',
          expiresAt: existing.expiresAt,
          lastError: existing.lastError,
        };
      }
    }

    try {
      const generated = await this.generateAiCatalog(openai);
      const merged = mergeServiceDiscoverySignatures(BUILTIN_DISCOVERY_SIGNATURES, generated);

      await this.prisma.serviceDiscoveryCatalog.upsert({
        where: { id: DISCOVERY_CATALOG_ID },
        update: {
          entries: {
            services: generated,
          } as Prisma.InputJsonValue,
          source: 'HYBRID',
          expiresAt: new Date(Date.now() + ttlSec * 1_000),
          lastError: null,
        },
        create: {
          id: DISCOVERY_CATALOG_ID,
          entries: {
            services: generated,
          } as Prisma.InputJsonValue,
          source: 'HYBRID',
          expiresAt: new Date(Date.now() + ttlSec * 1_000),
          lastError: null,
        },
      });

      return {
        signatures: merged,
        source: 'HYBRID',
        expiresAt: new Date(Date.now() + ttlSec * 1_000),
        lastError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI catalog generation failed';
      await this.prisma.serviceDiscoveryCatalog.upsert({
        where: { id: DISCOVERY_CATALOG_ID },
        update: {
          source: 'BUILTIN',
          expiresAt: new Date(Date.now() + Math.min(ttlSec, 3_600) * 1_000),
          lastError: message,
        },
        create: {
          id: DISCOVERY_CATALOG_ID,
          entries: { services: [] } as Prisma.InputJsonValue,
          source: 'BUILTIN',
          expiresAt: new Date(Date.now() + Math.min(ttlSec, 3_600) * 1_000),
          lastError: message,
        },
      });

      return {
        signatures: BUILTIN_DISCOVERY_SIGNATURES,
        source: 'BUILTIN',
        expiresAt: new Date(Date.now() + ttlSec * 1_000),
        lastError: message,
      };
    }
  }

  private async generateAiCatalog(openai: {
    responses: {
      create: (input: Record<string, unknown>) => Promise<{ output_text?: string | null }>;
    };
  }) {
    const response = await openai.responses.create({
      model: this.aiProviderService.getModel(),
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'Return valid JSON only with no markdown.',
                'Provide homelab service discovery signatures.',
                'Each signature must be safe for agent-local probing only.',
                'Do not include arbitrary commands or external scan instructions.',
                'JSON shape:',
                JSON.stringify({
                  services: [
                    {
                      id: 'service-id',
                      name: 'Service Name',
                      aliases: ['alias'],
                      systemdHints: ['unit-name'],
                      containerHints: ['image-or-name'],
                      processHints: ['process-name'],
                      tags: ['category'],
                      probes: [
                        {
                          protocol: 'http',
                          ports: [80],
                          path: '/',
                          statusCodes: [200],
                          bodyContains: ['marker'],
                          headersContain: ['header-marker'],
                        },
                      ],
                    },
                  ],
                }),
              ].join(' '),
            },
          ],
        },
      ],
      max_output_tokens: 2_000,
    });

    const output = (response.output_text ?? '').trim();
    if (!output || output.length > AI_CATALOG_MAX_BYTES) {
      throw new Error('AI catalog output is empty or too large');
    }

    const parsed = parseJsonObject(output);
    const validated = aiCatalogEnvelopeSchema.parse(parsed);
    return validated.services;
  }
}

/**
 * Implements format probe label.
 */
function formatProbeLabel(probe: {
  protocol: 'http' | 'https' | 'tcp';
  port: number;
  path?: string;
}) {
  const path = probe.path ? probe.path.trim() : '';
  return `${probe.protocol.toUpperCase()}:${probe.port}${path ? path : ''}`;
}

/**
 * Implements sanitize console message.
 */
function sanitizeConsoleMessage(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= DISCOVERY_CONSOLE_MESSAGE_MAX) {
    return compact;
  }
  return `${compact.slice(0, DISCOVERY_CONSOLE_MESSAGE_MAX - 3)}...`;
}

/**
 * Sets settled value.
 */
function settledValue(result: PromiseSettledResult<Record<string, unknown>>) {
  if (result.status === 'fulfilled') {
    return result.value;
  }
  return {};
}

/**
 * Implements flatten probe templates.
 */
function flattenProbeTemplates(templates: DiscoveryProbeTemplate[]) {
  const probes: Array<{
    protocol: 'http' | 'https' | 'tcp';
    port: number;
    path?: string;
    statusCodes?: number[];
    bodyContains?: string[];
    headersContain?: string[];
  }> = [];

  for (const template of templates) {
    for (const port of template.ports) {
      probes.push({
        protocol: template.protocol,
        port,
        path: template.path,
        statusCodes: template.statusCodes,
        bodyContains: template.bodyContains,
        headersContain: template.headersContain,
      });
    }
  }

  return probes;
}

/**
 * Implements evaluate passive.
 */
function evaluatePassive(
  signature: ServiceDiscoverySignature,
  inventory: {
    systemdNames: string[];
    containerTexts: string[];
    processTexts: string[];
  },
): PassiveEvidence {
  const aliasMatches = matchHints(
    [signature.name, ...signature.aliases],
    [...inventory.systemdNames, ...inventory.containerTexts, ...inventory.processTexts],
  );
  const systemdMatches = matchHints(signature.systemdHints, inventory.systemdNames);
  const containerMatches = matchHints(signature.containerHints, inventory.containerTexts);
  const processMatches = matchHints(signature.processHints, inventory.processTexts);

  return {
    aliasMatches,
    systemdMatches,
    containerMatches,
    processMatches,
  };
}

/**
 * Implements match hints.
 */
function matchHints(hints: string[], haystacks: string[]) {
  const normalizedHaystacks = haystacks.map((item) => item.toLowerCase());
  const matches = new Set<string>();

  for (const hint of hints) {
    const normalizedHint = hint.trim().toLowerCase();
    if (!normalizedHint) {
      continue;
    }
    for (const haystack of normalizedHaystacks) {
      if (haystack.includes(normalizedHint)) {
        matches.add(hint);
        break;
      }
    }
  }

  return Array.from(matches.values());
}

/**
 * Parses json object.
 */
function parseJsonObject(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    }
    throw new Error('AI output was not valid JSON');
  }
}

/**
 * Implements to probe from endpoint.
 */
function toProbeFromEndpoint(endpoint: string | null) {
  if (!endpoint) {
    return null;
  }

  const normalized = endpoint.trim();
  if (normalized.length === 0) {
    return null;
  }

  /**
   * Parses url.
   */
  const parseUrl = (value: string) => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };

  const candidate = parseUrl(normalized) ?? parseUrl(`http://${normalized}`);
  if (!candidate) {
    return null;
  }

  const scheme = candidate.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'tcp') {
    return null;
  }

  const defaultPort = scheme === 'https' ? 443 : scheme === 'http' ? 80 : 0;
  const parsedPort = candidate.port.length > 0 ? Number(candidate.port) : defaultPort;
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return null;
  }

  if (scheme === 'tcp') {
    return {
      protocol: 'tcp' as const,
      port: parsedPort,
    };
  }

  const joinedPath = `${candidate.pathname || '/'}${candidate.search || ''}`.trim();
  const path =
    joinedPath.length > 0 ? (joinedPath.startsWith('/') ? joinedPath : `/${joinedPath}`) : '/';

  return {
    protocol: scheme as 'http' | 'https',
    port: parsedPort,
    path: path.slice(0, 256),
  };
}

/**
 * Implements extract discovery source agent id.
 */
function extractDiscoverySourceAgentId(source: string | null | undefined) {
  if (!source) {
    return null;
  }
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const separators = ['subnet-discovery:', 'agent-discovery:'];
  for (const separator of separators) {
    if (!trimmed.startsWith(separator)) {
      continue;
    }
    const candidate = trimmed.slice(separator.length).trim();
    return candidate.length > 0 ? candidate : null;
  }
  return null;
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/**
 * Implements merge discovery verification metadata.
 */
function mergeDiscoveryVerificationMetadata(
  metadata: unknown,
  input: {
    checkedAt: string;
    status: 'up' | 'down' | 'skipped';
    endpoint: string | null;
    reason?: string;
  },
) {
  const existing = toRecord(metadata);
  const currentVerification = toRecord(existing.discoveryVerification);
  return {
    ...existing,
    discoveryVerification: {
      ...currentVerification,
      checkedAt: input.checkedAt,
      status: input.status,
      endpoint: input.endpoint,
      reason: input.reason ?? null,
    },
  };
}

/**
 * Implements read array.
 */
function readArray(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return Array.isArray(current) ? current : null;
}

/**
 * Implements read string.
 */
function readString(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (typeof current !== 'string') {
    return null;
  }
  const trimmed = current.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Implements read number.
 */
function readNumber(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (typeof current === 'number' && Number.isFinite(current)) {
    return current;
  }
  if (typeof current === 'string') {
    const parsed = Number(current.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Implements read string array.
 */
function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Implements clamp number.
 */
function clampNumber(value: number | undefined, fallback: number, min: number, max: number) {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(candidate)));
}

/**
 * Implements clamp float.
 */
function clampFloat(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
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
 * Implements normalize cidr list.
 */
function normalizeCidrList(values: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed) || !isValidIpv4Cidr(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 128) {
      break;
    }
  }
  return normalized;
}

/**
 * Parses ip list.
 */
function parseIpList(value: unknown, limit: number) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const ip = entry.trim();
    if (!ip || seen.has(ip) || !isValidIpv4Address(ip)) {
      continue;
    }
    seen.add(ip);
    items.push(ip);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

/**
 * Checks whether valid ipv4 cidr.
 */
function isValidIpv4Cidr(value: string) {
  const parts = value.split('/');
  if (parts.length !== 2) {
    return false;
  }

  const ip = parts[0];
  const prefixRaw = parts[1];
  if (!ip || !prefixRaw) {
    return false;
  }

  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const octets = ip.split('.');
  if (octets.length !== 4) {
    return false;
  }

  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) {
      return false;
    }
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

/**
 * Checks whether valid ipv4 address.
 */
function isValidIpv4Address(value: string) {
  const octets = value.split('.');
  if (octets.length !== 4) {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) {
      return false;
    }
    const parsed = Number(octet);
    return parsed >= 0 && parsed <= 255;
  });
}

/**
 * Implements merge string lists.
 */
function mergeStringLists(existing: string[], additions: string[]) {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of [...existing, ...additions]) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    merged.push(trimmed);
  }

  return merged;
}

/**
 * Implements delay.
 */
function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements dashboard agent service business logic for the service layer.
 */
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  dashboardAgentCategorySchema,
  dashboardAgentConfigResponseSchema,
  dashboardAgentConfigSchema,
  dashboardAgentHighlightsResponseSchema,
  dashboardAgentOpenAiCallSchema,
  dashboardAgentRunDeleteResponseSchema,
  dashboardAgentRunDetailResponseSchema,
  dashboardAgentRunHistoryItemSchema,
  dashboardAgentRunStatusSchema,
  dashboardAgentRunSummarySchema,
  dashboardAgentRunsResponseSchema,
  dashboardAgentSeveritySchema,
  dashboardAgentStatusResponseSchema,
  type DashboardAgentConfig,
  type DashboardAgentHighlight,
  type DashboardAgentOpenAiCall,
  type DashboardAgentRunDeleteResponse,
  type DashboardAgentRunHistoryItem,
  type DashboardAgentToolCall,
} from '@homelab/shared';
import { EventSeverity, type Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../events/events.service';
import { McpService } from '../mcp/mcp.service';
import { DashboardAgentMcpService } from './dashboard-agent.mcp.service';

const DASHBOARD_AGENT_CONFIG_ID = 'global';
const MAX_HIGHLIGHTS = 12;
const OPENAI_DEBUG_MAX_DEPTH = 6;
const OPENAI_DEBUG_MAX_ARRAY_ITEMS = 80;
const OPENAI_DEBUG_MAX_OBJECT_KEYS = 80;
const OPENAI_DEBUG_MAX_STRING_LENGTH = 1_600;
const OPENAI_DEBUG_MAX_OUTPUT_TEXT = 12_000;
const OPENAI_DEBUG_REASONING_LIMIT = 20;
const OPENAI_DEBUG_REASONING_LINE_MAX = 1_200;

const debugSecretKeyMarkers = [
  'token',
  'password',
  'secret',
  'authorization',
  'api_key',
  'apikey',
  'credential',
  'cookie',
  'privatekey',
];

const DEFAULT_DASHBOARD_AGENT_PERSONALITY = [
  'You are Dashboard Agent, a read-only homelab analyst.',
  'Prioritize anomalies that can impact uptime, security, and operator response time.',
  'Cross-reference monitors, telemetry trends, events, discovery runs, and AI question patterns.',
  'Be concise and action-oriented, and avoid low-value noise.',
].join(' ');

type RunTrigger = 'SCHEDULE' | 'MANUAL';
type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
type FindingSeverity = DashboardAgentHighlight['severity'];
type DashboardAgentRunViewOptions = {
  includeDebug?: boolean;
};

type HostMetricPoint = {
  at: string;
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  networkKbps: number | null;
  diskIoOps: number | null;
};

type HostMetricHistory = {
  hostId: string;
  hostName: string;
  status: string;
  lastSeenAt: string | null;
  latest: {
    cpuPct: number | null;
    memPct: number | null;
    diskPct: number | null;
  };
  points: HostMetricPoint[];
};

type MonitorHistoryItem = {
  checkedAt: string;
  status: string;
  latencyMs: number | null;
  httpStatus: number | null;
  errorMessage: string | null;
};

type MonitorResult = {
  id: string;
  name: string;
  type: string;
  target: string;
  enabled: boolean;
  hostId: string | null;
  serviceId: string | null;
  latestStatus: string;
  downCount: number;
  warnCount: number;
  unknownCount: number;
  history: MonitorHistoryItem[];
};

type DiscoveryRunSnapshot = {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  detectedCount: number;
  upsertCount: number;
  errorCount: number;
  error: string | null;
  summary: unknown;
};

type AiQuestionRecord = {
  id: string;
  conversationId: string;
  createdAt: string;
  text: string;
};

type EventRecord = {
  id: string;
  type: string;
  severity: string;
  message: string;
  hostId: string | null;
  serviceId: string | null;
  checkId: string | null;
  createdAt: string;
};

type DashboardAgentConfigRow = {
  id: string;
  enabled: boolean;
  intervalSec: number;
  escalateCreateEvents: boolean;
  personality: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DashboardAgentRunRow = {
  id: string;
  trigger: string;
  triggeredByUserId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  findingCount: number;
  highPriorityCount: number;
  highlights: Prisma.JsonValue | null;
  summary: Prisma.JsonValue | null;
  error: string | null;
};

type DashboardAgentConfigStore = {
  findUnique: (args: Record<string, unknown>) => Promise<DashboardAgentConfigRow | null>;
  upsert: (args: Record<string, unknown>) => Promise<DashboardAgentConfigRow>;
};

type DashboardAgentRunStore = {
  findFirst: (args: Record<string, unknown>) => Promise<DashboardAgentRunRow | null>;
  findMany: (args: Record<string, unknown>) => Promise<DashboardAgentRunRow[]>;
  findUnique: (args: Record<string, unknown>) => Promise<DashboardAgentRunRow | null>;
  create: (args: Record<string, unknown>) => Promise<DashboardAgentRunRow>;
  update: (args: Record<string, unknown>) => Promise<DashboardAgentRunRow>;
  delete: (args: Record<string, unknown>) => Promise<{ id: string; status: string }>;
};

type DashboardAgentContext = {
  homelabSnapshot: {
    hosts: number;
    services: number;
    monitors: number;
    activeAlerts: number;
  };
  hostMetrics: HostMetricHistory[];
  monitorResults: MonitorResult[];
  discoveryRuns: DiscoveryRunSnapshot[];
  aiQuestions: AiQuestionRecord[];
  events: EventRecord[];
};

const aiRefinementSchema = z
  .object({
    notes: z.array(z.string().min(1).max(240)).max(20).optional(),
    highlights: z
      .array(dashboardAgentRunHistoryItemSchema.shape.highlights.unwrap().element)
      .max(MAX_HIGHLIGHTS),
  })
  .strict();

@Injectable()
/**
 * Implements the dashboard agent service class.
 */
export class DashboardAgentService {
  private runActive = false;
  private activeRunId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly eventsService: EventsService,
    private readonly mcpService: McpService,
    private readonly dashboardAgentMcpService: DashboardAgentMcpService,
    private readonly aiProviderService: AiProviderService,
  ) {}

  /**
   * Gets status.
   */
  async getStatus() {
    const runStore = this.getRunStore();
    const [configState, latestRun] = await Promise.all([
      this.readConfigState(),
      runStore.findFirst({
        orderBy: { startedAt: 'desc' },
      }),
    ]);

    const nextScheduledRunAt = this.computeNextScheduledRunAt(
      configState.config,
      latestRun?.startedAt ?? null,
    );

    return dashboardAgentStatusResponseSchema.parse({
      enabled: configState.config.enabled,
      intervalSec: configState.config.intervalSec,
      isRunning: this.runActive,
      nextScheduledRunAt,
      lastRunAt: latestRun?.startedAt ? latestRun.startedAt.toISOString() : null,
      lastRunId: latestRun?.id ?? null,
      lastRunStatus: normalizeRunStatus(latestRun?.status ?? null),
    });
  }

  /**
   * Gets config.
   */
  async getConfig() {
    const runStore = this.getRunStore();
    const [configState, latestRun] = await Promise.all([
      this.readConfigState(),
      runStore.findFirst({
        orderBy: { startedAt: 'desc' },
      }),
    ]);

    const nextScheduledRunAt = this.computeNextScheduledRunAt(
      configState.config,
      latestRun?.startedAt ?? null,
    );

    return dashboardAgentConfigResponseSchema.parse({
      config: configState.config,
      defaultPersonality: DEFAULT_DASHBOARD_AGENT_PERSONALITY,
      nextScheduledRunAt,
      lastRunAt: latestRun?.startedAt ? latestRun.startedAt.toISOString() : null,
      isRunning: this.runActive,
      updatedAt: configState.updatedAt,
    });
  }

  /**
   * Handles update config.
   */
  async updateConfig(actorUserId: string, config: DashboardAgentConfig) {
    const normalized = this.normalizeConfig(config);
    const configStore = this.getConfigStore();
    const updated = await configStore.upsert({
      where: {
        id: DASHBOARD_AGENT_CONFIG_ID,
      },
      update: {
        enabled: normalized.enabled,
        intervalSec: normalized.intervalSec,
        escalateCreateEvents: normalized.escalateCreateEvents,
        personality: normalized.personality,
        updatedByUserId: actorUserId,
      },
      create: {
        id: DASHBOARD_AGENT_CONFIG_ID,
        enabled: normalized.enabled,
        intervalSec: normalized.intervalSec,
        escalateCreateEvents: normalized.escalateCreateEvents,
        personality: normalized.personality,
        updatedByUserId: actorUserId,
      },
    });

    await this.auditService.write({
      actorUserId,
      action: 'dashboard.agent.config.update',
      targetType: 'dashboard_agent_config',
      targetId: updated.id,
      paramsJson: normalized as Prisma.InputJsonValue,
      success: true,
    });

    return this.getConfig();
  }

  /**
   * Handles list runs.
   */
  async listRuns(limit?: number, options: DashboardAgentRunViewOptions = {}) {
    const runStore = this.getRunStore();
    const take = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.trunc(limit as number)))
      : 20;

    const runs = await runStore.findMany({
      orderBy: { startedAt: 'desc' },
      take,
    });

    return dashboardAgentRunsResponseSchema.parse({
      runs: runs.map((run) => this.toRunHistoryItem(run, options)),
    });
  }

  /**
   * Gets run.
   */
  async getRun(runId: string, options: DashboardAgentRunViewOptions = {}) {
    const runStore = this.getRunStore();
    const run = await runStore.findUnique({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException('Dashboard agent run not found');
    }

    return dashboardAgentRunDetailResponseSchema.parse({
      run: this.toRunHistoryItem(run, options),
    });
  }

  /**
   * Removes run from the surrounding workflow.
   */
  async deleteRun(runId: string, actorUserId: string): Promise<DashboardAgentRunDeleteResponse> {
    const runStore = this.getRunStore();
    const run = await runStore.findUnique({
      where: { id: runId },
    });
    if (!run) {
      throw new NotFoundException('Dashboard agent run not found');
    }

    const normalizedStatus = normalizeRunStatus(run.status);
    if (normalizedStatus === 'RUNNING' || this.activeRunId === runId) {
      throw new BadRequestException('Cannot delete a running dashboard agent run');
    }

    const deleted = await runStore.delete({
      where: { id: runId },
      select: {
        id: true,
        status: true,
      },
    });

    await this.auditService.write({
      actorUserId,
      action: 'dashboard.agent.run.delete',
      targetType: 'dashboard_agent_run',
      targetId: deleted.id,
      resultJson: {
        deleted: true,
        status: normalizeRunStatus(deleted.status),
      } as Prisma.InputJsonValue,
      success: true,
    });

    return dashboardAgentRunDeleteResponseSchema.parse({
      ok: true,
      deleted: true,
      runId: deleted.id,
    });
  }

  /**
   * Gets highlights.
   */
  async getHighlights() {
    const runStore = this.getRunStore();
    const run = await runStore.findFirst({
      where: {
        highlights: {
          not: null,
        },
      },
      orderBy: { startedAt: 'desc' },
    });

    if (!run) {
      return dashboardAgentHighlightsResponseSchema.parse({
        runId: null,
        status: null,
        generatedAt: null,
        highlights: [],
      });
    }

    const normalized = this.toRunHistoryItem(run, {
      includeDebug: false,
    });

    return dashboardAgentHighlightsResponseSchema.parse({
      runId: normalized.id,
      status: normalized.status,
      generatedAt: normalized.finishedAt,
      highlights: normalized.highlights ?? [],
    });
  }

  /**
   * Handles trigger manual run.
   */
  async triggerManualRun(actorUserId: string) {
    if (this.runActive) {
      throw new BadRequestException('Dashboard agent run already in progress');
    }

    await this.auditService.write({
      actorUserId,
      action: 'dashboard.agent.run.trigger',
      targetType: 'dashboard_agent',
      paramsJson: {
        trigger: 'MANUAL',
      },
      success: true,
    });

    return this.executeRun({
      trigger: 'MANUAL',
      triggeredByUserId: actorUserId,
    });
  }

  /**
   * Handles trigger scheduled run if due.
   */
  async triggerScheduledRunIfDue() {
    if (this.runActive) {
      return;
    }

    const configState = await this.readConfigState();
    if (!configState.config.enabled) {
      return;
    }

    const runStore = this.getRunStore();
    const latestRun = await runStore.findFirst({
      orderBy: { startedAt: 'desc' },
    });

    if (!latestRun) {
      await this.executeRun({ trigger: 'SCHEDULE' });
      return;
    }

    const intervalMs = configState.config.intervalSec * 1_000;
    if (Date.now() >= latestRun.startedAt.getTime() + intervalMs) {
      await this.executeRun({ trigger: 'SCHEDULE' });
    }
  }

  /**
   * Implements the execute run workflow for this file.
   */
  private async executeRun(input: { trigger: RunTrigger; triggeredByUserId?: string }) {
    if (this.runActive) {
      throw new BadRequestException('Dashboard agent run already in progress');
    }

    this.runActive = true;

    const runStore = this.getRunStore();
    const run = await runStore.create({
      data: {
        trigger: input.trigger,
        triggeredByUserId: input.triggeredByUserId,
        status: 'RUNNING',
      },
    });

    this.activeRunId = run.id;
    const toolCalls: DashboardAgentToolCall[] = [];
    const openAiCalls: DashboardAgentOpenAiCall[] = [];

    try {
      const configState = await this.readConfigState();
      const context = await this.collectContext(toolCalls);

      let highlights = this.buildHeuristicHighlights(context);
      highlights = await this.enrichHighlights(highlights, context, toolCalls);
      const aiRefined = await this.refineWithAi(
        highlights,
        context,
        configState.config.personality,
        toolCalls,
        openAiCalls,
      );
      highlights = aiRefined.length > 0 ? aiRefined : highlights;

      if (highlights.length === 0) {
        highlights.push({
          id: randomUUID(),
          title: 'No urgent anomalies detected',
          summary:
            'The latest scan did not find high-priority problems requiring immediate action.',
          severity: 'info',
          category: 'system',
          confidence: 0.64,
          evidence: [
            `${context.monitorResults.length} monitors reviewed`,
            `${context.hostMetrics.length} hosts reviewed`,
            `${context.events.length} recent events analyzed`,
          ],
          investigation: [
            'No repeated failures or severe event spikes were detected in the sampled window.',
          ],
          recommendedActions: ['Continue observing routine monitor and alert trends.'],
        });
      }

      const ranked = rankHighlights(highlights).slice(0, MAX_HIGHLIGHTS);
      const eventEmittedIds = await this.emitEscalations(
        ranked,
        configState.config.escalateCreateEvents,
      );
      const finalized = ranked.map((highlight) =>
        eventEmittedIds.has(highlight.id)
          ? {
              ...highlight,
              eventEmitted: true,
            }
          : highlight,
      );

      const summary = this.buildRunSummary(
        context,
        toolCalls,
        openAiCalls,
        await this.aiProviderService.isConfigured(),
      );
      const highPriorityCount = finalized.filter(
        (highlight) => highlight.severity !== 'info',
      ).length;

      const completed = await runStore.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          findingCount: finalized.length,
          highPriorityCount,
          highlights: finalized as Prisma.InputJsonValue,
          summary: summary as Prisma.InputJsonValue,
          error: null,
        },
      });

      await this.auditService.write({
        actorUserId: input.triggeredByUserId,
        action: 'dashboard.agent.run.complete',
        targetType: 'dashboard_agent_run',
        targetId: completed.id,
        resultJson: {
          status: completed.status,
          findingCount: completed.findingCount,
          highPriorityCount: completed.highPriorityCount,
        } as Prisma.InputJsonValue,
        success: true,
      });

      return this.toRunHistoryItem(completed, {
        includeDebug: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Dashboard agent run failed';
      const failedSummary = dashboardAgentRunSummarySchema.parse({
        analyzedAt: new Date().toISOString(),
        context: {
          hosts: 0,
          monitors: 0,
          services: 0,
          activeAlerts: 0,
          discoveryRunsReviewed: 0,
          aiQuestionsReviewed: 0,
          eventsReviewed: 0,
        },
        notes: [`Run failed before analysis completed: ${compact(message, 200)}`],
        toolCalls,
        openAiCalls,
      });

      const failed = await runStore.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: message,
          summary: failedSummary as Prisma.InputJsonValue,
        },
      });

      await this.auditService.write({
        actorUserId: input.triggeredByUserId,
        action: 'dashboard.agent.run.complete',
        targetType: 'dashboard_agent_run',
        targetId: failed.id,
        resultJson: {
          status: failed.status,
          error: message,
        } as Prisma.InputJsonValue,
        success: false,
      });

      return this.toRunHistoryItem(failed, {
        includeDebug: true,
      });
    } finally {
      this.activeRunId = null;
      this.runActive = false;
    }
  }

  private async collectContext(
    toolCalls: DashboardAgentToolCall[],
  ): Promise<DashboardAgentContext> {
    const snapshot = await this.callReadonlyTool<{
      hosts: number;
      services: number;
      monitors: number;
      activeAlerts: number;
    }>('homelab.snapshot', {}, toolCalls);

    const hostMetrics = await this.callReadonlyTool<{ hosts: HostMetricHistory[] }>(
      'metrics.host.history',
      {
        hours: 24,
        limitPerHost: 96,
      },
      toolCalls,
    );

    const monitorResults = await this.callReadonlyTool<{ monitors: MonitorResult[] }>(
      'monitors.results',
      {
        hours: 24,
        limitPerMonitor: 30,
      },
      toolCalls,
    );

    const discoveryRuns = await this.callReadonlyTool<{ runs: DiscoveryRunSnapshot[] }>(
      'discovery.runs',
      {
        limit: 10,
      },
      toolCalls,
    );

    const aiQuestions = await this.callReadonlyTool<{ questions: AiQuestionRecord[] }>(
      'ai.questions',
      {
        hours: 72,
        limit: 50,
      },
      toolCalls,
    );

    const recentEvents = await this.callReadonlyTool<{ events: EventRecord[] }>(
      'events.recent',
      {
        hours: 24,
        limit: 150,
      },
      toolCalls,
    );

    return {
      homelabSnapshot: {
        hosts: snapshot?.hosts ?? 0,
        services: snapshot?.services ?? 0,
        monitors: snapshot?.monitors ?? 0,
        activeAlerts: snapshot?.activeAlerts ?? 0,
      },
      hostMetrics: hostMetrics?.hosts ?? [],
      monitorResults: monitorResults?.monitors ?? [],
      discoveryRuns: discoveryRuns?.runs ?? [],
      aiQuestions: aiQuestions?.questions ?? [],
      events: recentEvents?.events ?? [],
    };
  }

  /**
   * Builds heuristic highlights for the surrounding workflow.
   */
  private buildHeuristicHighlights(context: DashboardAgentContext): DashboardAgentHighlight[] {
    const findings: DashboardAgentHighlight[] = [];

    for (const host of context.hostMetrics) {
      const cpu = host.latest.cpuPct ?? 0;
      const mem = host.latest.memPct ?? 0;
      const disk = host.latest.diskPct ?? 0;
      const cpuBaseline = median(
        host.points
          .slice(0, -1)
          .map((point) => point.cpuPct)
          .filter(isFiniteNumber),
      );
      const memBaseline = median(
        host.points
          .slice(0, -1)
          .map((point) => point.memPct)
          .filter(isFiniteNumber),
      );

      if (cpu >= 90 || mem >= 92 || disk >= 92) {
        findings.push({
          id: randomUUID(),
          title: `${host.hostName} resource pressure`,
          summary: `${host.hostName} is reporting critically high utilization and may need immediate investigation.`,
          severity: 'critical',
          category: 'host',
          confidence: 0.89,
          evidence: [
            `CPU ${toPercent(cpu)}`,
            `Memory ${toPercent(mem)}`,
            `Disk ${toPercent(disk)}`,
          ],
          investigation: [],
          recommendedActions: [
            'Check top processes and containers on this host.',
            'Confirm monitor failures are not cascading from this saturation.',
          ],
          references: {
            hostId: host.hostId,
          },
        });
      } else {
        if (cpuBaseline !== null && cpu - cpuBaseline >= 25 && cpu >= 70) {
          findings.push({
            id: randomUUID(),
            title: `${host.hostName} CPU spike`,
            summary: `${host.hostName} CPU usage is materially above its recent baseline.`,
            severity: 'warn',
            category: 'host',
            confidence: 0.81,
            evidence: [`Current CPU ${toPercent(cpu)}`, `Baseline CPU ${toPercent(cpuBaseline)}`],
            investigation: [],
            recommendedActions: ['Inspect workloads started recently on this host.'],
            references: {
              hostId: host.hostId,
            },
          });
        }

        if (memBaseline !== null && mem - memBaseline >= 22 && mem >= 75) {
          findings.push({
            id: randomUUID(),
            title: `${host.hostName} memory growth`,
            summary: `${host.hostName} memory usage is climbing relative to normal levels.`,
            severity: 'warn',
            category: 'host',
            confidence: 0.78,
            evidence: [
              `Current memory ${toPercent(mem)}`,
              `Baseline memory ${toPercent(memBaseline)}`,
            ],
            investigation: [],
            recommendedActions: ['Review long-running services for memory growth or leaks.'],
            references: {
              hostId: host.hostId,
            },
          });
        }
      }
    }

    for (const monitor of context.monitorResults) {
      if (monitor.history.length === 0) {
        continue;
      }

      const streak = downStreak(monitor.history);
      const flaps = transitionCount(monitor.history.slice(0, 8).map((item) => item.status));
      const latest = monitor.history[0];

      if (streak >= 3) {
        findings.push({
          id: randomUUID(),
          title: `Monitor down: ${monitor.name}`,
          summary: `${monitor.name} has been down for ${streak} consecutive runs.`,
          severity: streak >= 5 ? 'critical' : 'warn',
          category: 'monitor',
          confidence: 0.9,
          evidence: [
            `${monitor.type} target ${compact(monitor.target, 80)}`,
            `Down count in window ${monitor.downCount}`,
            latest?.errorMessage
              ? `Latest error: ${compact(latest.errorMessage, 120)}`
              : 'Latest error: not reported',
          ],
          investigation: [],
          recommendedActions: [
            'Validate endpoint reachability from source host.',
            'Cross-check related host and service events for correlated failures.',
          ],
          references: {
            monitorId: monitor.id,
            hostId: monitor.hostId ?? undefined,
          },
        });
      } else if (flaps >= 3 && monitor.downCount > 0) {
        findings.push({
          id: randomUUID(),
          title: `Monitor flapping: ${monitor.name}`,
          summary: `${monitor.name} is alternating states frequently, which often indicates intermittent instability.`,
          severity: 'warn',
          category: 'monitor',
          confidence: 0.74,
          evidence: [
            `State transitions in last ${Math.min(8, monitor.history.length)} runs: ${flaps}`,
            `Down count in window ${monitor.downCount}`,
          ],
          investigation: [],
          recommendedActions: ['Inspect network path, dependency health, and timeout thresholds.'],
          references: {
            monitorId: monitor.id,
            hostId: monitor.hostId ?? undefined,
          },
        });
      }
    }

    const latestDiscoveryRun = context.discoveryRuns[0];
    const previousDiscoveryRun = context.discoveryRuns[1];
    if (latestDiscoveryRun) {
      if (latestDiscoveryRun.status === 'FAILED') {
        findings.push({
          id: randomUUID(),
          title: 'Service discovery run failed',
          summary:
            'The latest service discovery execution failed and may hide topology or service drift.',
          severity: 'warn',
          category: 'service-discovery',
          confidence: 0.84,
          evidence: [
            `Run ${latestDiscoveryRun.id}`,
            latestDiscoveryRun.error
              ? `Error: ${compact(latestDiscoveryRun.error, 180)}`
              : 'Error details not recorded',
          ],
          investigation: [],
          recommendedActions: ['Review discovery run logs and retry after agent/tool validation.'],
          references: {
            discoveryRunId: latestDiscoveryRun.id,
          },
        });
      }

      if (
        previousDiscoveryRun &&
        latestDiscoveryRun.status === 'COMPLETED' &&
        previousDiscoveryRun.status === 'COMPLETED' &&
        Math.abs(latestDiscoveryRun.detectedCount - previousDiscoveryRun.detectedCount) >= 8
      ) {
        findings.push({
          id: randomUUID(),
          title: 'Discovery detection volume shifted',
          summary: 'Recent discovery detections changed significantly compared with the prior run.',
          severity: 'info',
          category: 'service-discovery',
          confidence: 0.68,
          evidence: [
            `Latest detections ${latestDiscoveryRun.detectedCount}`,
            `Previous detections ${previousDiscoveryRun.detectedCount}`,
          ],
          investigation: [],
          recommendedActions: [
            'Confirm whether planned deployments or outages explain this shift.',
          ],
          references: {
            discoveryRunId: latestDiscoveryRun.id,
          },
        });
      }
    }

    const errorEvents = context.events.filter((event) => event.severity === 'ERROR');
    if (errorEvents.length >= 8) {
      findings.push({
        id: randomUUID(),
        title: 'High error-event volume',
        summary:
          'The event stream shows an elevated number of ERROR severity records in the recent window.',
        severity: errorEvents.length >= 15 ? 'critical' : 'warn',
        category: 'event',
        confidence: 0.77,
        evidence: [
          `${errorEvents.length} ERROR events in the last 24 hours`,
          `Latest: ${compact(errorEvents[0]?.message ?? 'n/a', 120)}`,
        ],
        investigation: [],
        recommendedActions: [
          'Prioritize recurring event types and correlate against failing monitors/hosts.',
        ],
      });
    }

    const repeatedQuestions = mostRepeatedQuestion(context.aiQuestions);
    if (repeatedQuestions && repeatedQuestions.count >= 3) {
      findings.push({
        id: randomUUID(),
        title: 'Repeated operator AI question pattern',
        summary:
          'Operators repeatedly asked similar AI questions, which can signal unresolved operational friction.',
        severity: repeatedQuestions.count >= 5 ? 'warn' : 'info',
        category: 'ai-activity',
        confidence: 0.66,
        evidence: [
          `Question repeated ${repeatedQuestions.count} times`,
          `Sample: ${compact(repeatedQuestions.text, 140)}`,
        ],
        investigation: [],
        recommendedActions: [
          'Check related alerts and monitors to confirm whether the underlying issue is still active.',
        ],
      });
    }

    return rankHighlights(findings);
  }

  private async enrichHighlights(
    highlights: DashboardAgentHighlight[],
    context: DashboardAgentContext,
    toolCalls: DashboardAgentToolCall[],
  ) {
    const enriched: DashboardAgentHighlight[] = [];

    for (const finding of highlights) {
      const next: DashboardAgentHighlight = {
        ...finding,
        investigation: [...finding.investigation],
      };

      const monitorId = finding.references?.monitorId;
      if (monitorId) {
        const monitor = context.monitorResults.find((candidate) => candidate.id === monitorId);
        if (monitor) {
          const monitorEvents = context.events
            .filter((event) => event.checkId === monitorId)
            .slice(0, 3)
            .map((event) => `${event.type}: ${compact(event.message, 120)}`);
          if (monitorEvents.length > 0) {
            next.investigation.push(`Related events: ${monitorEvents.join(' | ')}`);
          }

          if (monitor.hostId) {
            const hostLabel = context.hostMetrics.find(
              (host) => host.hostId === monitor.hostId,
            )?.hostName;
            if (hostLabel) {
              next.investigation.push(`Monitor is bound to host ${hostLabel}.`);
            }
          }
        }
      }

      const hostId = finding.references?.hostId;
      if (hostId) {
        const impactedMonitors = context.monitorResults
          .filter((monitor) => monitor.hostId === hostId && monitor.downCount > 0)
          .slice(0, 3)
          .map((monitor) => `${monitor.name} (${monitor.downCount} downs)`);
        if (impactedMonitors.length > 0) {
          next.investigation.push(`Host-linked monitor failures: ${impactedMonitors.join(', ')}`);
        }

        const topProcessSummary = await this.inspectTopProcesses(hostId, toolCalls);
        if (topProcessSummary) {
          next.investigation.push(topProcessSummary);
        }
      }

      const discoveryRunId = finding.references?.discoveryRunId;
      if (discoveryRunId) {
        const discoveryEvents = context.events
          .filter((event) => event.type.includes('service.discovery'))
          .slice(0, 2)
          .map((event) => compact(event.message, 120));
        if (discoveryEvents.length > 0) {
          next.investigation.push(`Recent discovery events: ${discoveryEvents.join(' | ')}`);
        }
        next.investigation.push(`Discovery run reference: ${discoveryRunId}`);
      }

      if (finding.category === 'ai-activity' && context.homelabSnapshot.activeAlerts > 0) {
        next.investigation.push(
          `${context.homelabSnapshot.activeAlerts} active alerts are currently open while questions repeat.`,
        );
      }

      enriched.push(next);
    }

    return enriched;
  }

  private async refineWithAi(
    highlights: DashboardAgentHighlight[],
    context: DashboardAgentContext,
    personality: string,
    toolCalls: DashboardAgentToolCall[],
    openAiCalls: DashboardAgentOpenAiCall[],
  ) {
    if (highlights.length === 0) {
      return highlights;
    }

    const openai = await this.aiProviderService.getClient();
    if (!openai) {
      return highlights;
    }

    const model = this.aiProviderService.getModel();
    const resolvedPersonality =
      personality.trim().length > 0 ? personality.trim() : DEFAULT_DASHBOARD_AGENT_PERSONALITY;
    const requestPayload = {
      model,
      reasoning: {
        summary: 'auto' as const,
      },
      input: [
        {
          role: 'system' as const,
          content: [
            {
              type: 'input_text' as const,
              text: [
                'You produce read-only homelab triage summaries.',
                'Return strict JSON only. No markdown.',
                'Do not suggest executing write actions directly.',
                'Prioritize findings requiring operator attention.',
                `Style preferences: ${resolvedPersonality}`,
                'Output schema:',
                JSON.stringify({
                  notes: ['string'],
                  highlights: [
                    {
                      id: 'uuid-or-stable-id',
                      title: 'string',
                      summary: 'string',
                      severity: 'info|warn|critical',
                      category: 'monitor|host|service-discovery|event|ai-activity|system',
                      confidence: 0.8,
                      evidence: ['string'],
                      investigation: ['string'],
                      recommendedActions: ['string'],
                      references: {
                        hostId: 'uuid-optional',
                        monitorId: 'uuid-optional',
                        discoveryRunId: 'uuid-optional',
                      },
                    },
                  ],
                }),
              ].join(' '),
            },
          ],
        },
        {
          role: 'user' as const,
          content: [
            {
              type: 'input_text' as const,
              text: JSON.stringify({
                context: {
                  snapshot: context.homelabSnapshot,
                  discoveryRuns: context.discoveryRuns.slice(0, 5),
                  monitorCount: context.monitorResults.length,
                  hostCount: context.hostMetrics.length,
                  errorEventsLast24h: context.events.filter((event) => event.severity === 'ERROR')
                    .length,
                  aiQuestionsLast72h: context.aiQuestions.length,
                },
                draftHighlights: highlights,
              }),
            },
          ],
        },
      ],
    };
    const startedAt = new Date();

    try {
      const response = await openai.responses.create(requestPayload);
      const finishedAt = new Date();
      const reasoningSummary = extractReasoningSummary(response.output);
      const usage = toOpenAiUsageSnapshot(response.usage);
      const outputText = response.output_text
        ? sanitizeDebugString(response.output_text, OPENAI_DEBUG_MAX_OUTPUT_TEXT)
        : null;
      const baseEntry = {
        id: response.id || randomUUID(),
        step: 'refine_highlights',
        model,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        requestPayload: sanitizeDebugValue(requestPayload),
        responsePayload: sanitizeDebugValue({
          id: response.id,
          model: response.model,
          status: response.status ?? null,
          error: response.error,
          output: response.output,
        }),
        outputText,
        reasoningSummary,
        usage,
      } as const;

      const candidate = parseAiRefinementResponse(response.output_text ?? '', highlights);
      if (!candidate.success) {
        const errorDetails = candidate.error;
        toolCalls.push({
          tool: 'ai.synthesis',
          ok: false,
          details: compact(`${errorDetails}; using heuristic findings.`, 240),
        });
        openAiCalls.push(
          dashboardAgentOpenAiCallSchema.parse({
            ...baseEntry,
            status: 'invalid_output',
            error: errorDetails,
          }),
        );
        return highlights;
      }

      toolCalls.push({
        tool: 'ai.synthesis',
        ok: true,
        details: `Model refined ${candidate.data.highlights.length} highlight(s).`,
      });
      openAiCalls.push(
        dashboardAgentOpenAiCallSchema.parse({
          ...baseEntry,
          status: 'completed',
          error: null,
        }),
      );

      if (candidate.data.highlights.length === 0) {
        return highlights;
      }

      return candidate.data.highlights;
    } catch (error) {
      const finishedAt = new Date();
      const rawMessage = error instanceof Error ? error.message : 'AI refinement failed';
      const message = sanitizeDebugString(compact(rawMessage, 500), 500);
      toolCalls.push({
        tool: 'ai.synthesis',
        ok: false,
        details: compact(message, 180),
      });
      openAiCalls.push(
        dashboardAgentOpenAiCallSchema.parse({
          id: `ai-call-${randomUUID()}`,
          step: 'refine_highlights',
          model,
          status: 'failed',
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          requestPayload: sanitizeDebugValue(requestPayload),
          responsePayload: null,
          outputText: null,
          reasoningSummary: [],
          usage: null,
          error: message,
        }),
      );
      return highlights;
    }
  }

  /**
   * Handles inspect top processes.
   */
  private async inspectTopProcesses(hostId: string, toolCalls: DashboardAgentToolCall[]) {
    const agent = await this.prisma.agent.findFirst({
      where: {
        hostId,
        revokedAt: null,
        status: 'ONLINE',
      },
      orderBy: {
        lastSeenAt: 'desc',
      },
      select: {
        id: true,
      },
    });

    if (!agent) {
      return null;
    }

    try {
      const result = await this.mcpService.callTool({
        agentId: agent.id,
        toolName: 'host.top_processes',
        toolParams: {
          limit: 5,
        },
      });

      const top = extractTopProcessSummary(result);
      toolCalls.push({
        tool: 'agent.host.top_processes',
        ok: true,
        details: top ? 'Collected top process summary.' : 'No process details returned.',
      });

      return top;
    } catch (error) {
      toolCalls.push({
        tool: 'agent.host.top_processes',
        ok: false,
        details: compact(
          error instanceof Error ? error.message : 'Failed to inspect top processes',
          180,
        ),
      });
      return null;
    }
  }

  /**
   * Handles emit escalations.
   */
  private async emitEscalations(highlights: DashboardAgentHighlight[], enabled: boolean) {
    if (!enabled) {
      return new Set<string>();
    }

    const escalatedIds = new Set<string>();
    const candidates = highlights
      .filter((highlight) => highlight.severity === 'critical')
      .slice(0, 3);

    for (const highlight of candidates) {
      try {
        await this.eventsService.emit({
          type: 'dashboard.agent.finding',
          severity: mapSeverity(highlight.severity),
          message: highlight.title,
          payload: {
            summary: highlight.summary,
            category: highlight.category,
            confidence: highlight.confidence,
            recommendations: highlight.recommendedActions,
          } as Prisma.InputJsonValue,
        });
        escalatedIds.add(highlight.id);
      } catch {
        // Non-fatal: run should still complete even if event write fails.
      }
    }

    return escalatedIds;
  }

  private buildRunSummary(
    context: DashboardAgentContext,
    toolCalls: DashboardAgentToolCall[],
    openAiCalls: DashboardAgentOpenAiCall[],
    aiEnabled: boolean,
  ) {
    return dashboardAgentRunSummarySchema.parse({
      analyzedAt: new Date().toISOString(),
      context: {
        hosts: context.homelabSnapshot.hosts || context.hostMetrics.length,
        monitors: context.homelabSnapshot.monitors || context.monitorResults.length,
        services: context.homelabSnapshot.services,
        activeAlerts: context.homelabSnapshot.activeAlerts,
        discoveryRunsReviewed: context.discoveryRuns.length,
        aiQuestionsReviewed: context.aiQuestions.length,
        eventsReviewed: context.events.length,
      },
      notes: [
        aiEnabled
          ? 'AI refinement was attempted for final highlight prioritization.'
          : 'AI refinement unavailable; using heuristic ranking only.',
      ],
      toolCalls,
      openAiCalls,
    });
  }

  private toRunHistoryItem(
    run: {
      id: string;
      trigger: string;
      triggeredByUserId: string | null;
      startedAt: Date;
      finishedAt: Date | null;
      status: string;
      findingCount: number;
      highPriorityCount: number;
      highlights: Prisma.JsonValue | null;
      summary: Prisma.JsonValue | null;
      error: string | null;
    },
    options: DashboardAgentRunViewOptions = {},
  ): DashboardAgentRunHistoryItem {
    const parsedHighlights = parseHighlights(run.highlights);
    const filteredSummary = options.includeDebug
      ? run.summary
      : stripOpenAiCallsFromSummary(run.summary);

    return dashboardAgentRunHistoryItemSchema.parse({
      id: run.id,
      trigger: run.trigger === 'MANUAL' ? 'MANUAL' : 'SCHEDULE',
      triggeredByUserId: run.triggeredByUserId,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      status: normalizeRunStatus(run.status) ?? 'FAILED',
      findingCount: run.findingCount,
      highPriorityCount: run.highPriorityCount,
      highlights: parsedHighlights,
      error: run.error,
      summary: filteredSummary,
    });
  }

  /**
   * Handles read config state.
   */
  private async readConfigState() {
    const configStore = this.getConfigStore();
    const record = await configStore.findUnique({
      where: { id: DASHBOARD_AGENT_CONFIG_ID },
    });

    if (!record) {
      return {
        config: this.defaultConfig(),
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      config: this.normalizeConfig({
        enabled: record.enabled,
        intervalSec: record.intervalSec,
        escalateCreateEvents: record.escalateCreateEvents,
        personality: record.personality,
      }),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Implements the default config workflow for this file.
   */
  private defaultConfig(): DashboardAgentConfig {
    return {
      enabled: this.configService.get<boolean>('DASHBOARD_AGENT_ENABLED', true),
      intervalSec: this.configService.get<number>('DASHBOARD_AGENT_INTERVAL_SEC', 300),
      escalateCreateEvents: true,
      personality: '',
    };
  }

  /**
   * Normalizes config before the caller uses it.
   */
  private normalizeConfig(config: DashboardAgentConfig): DashboardAgentConfig {
    const personality = compactWhitespace(config.personality).slice(0, 6_000);

    return dashboardAgentConfigSchema.parse({
      enabled: config.enabled,
      intervalSec: Math.max(60, Math.min(86_400, Math.trunc(config.intervalSec))),
      escalateCreateEvents: config.escalateCreateEvents,
      personality,
    });
  }

  /**
   * Handles compute next scheduled run at.
   */
  private computeNextScheduledRunAt(config: DashboardAgentConfig, lastRunAt: Date | null) {
    if (!config.enabled) {
      return null;
    }

    const intervalMs = config.intervalSec * 1_000;
    const nowMs = Date.now();
    const nextDueMs = lastRunAt
      ? Math.max(nowMs, lastRunAt.getTime() + intervalMs)
      : nowMs + intervalMs;

    return new Date(nextDueMs).toISOString();
  }

  private async callReadonlyTool<T>(
    toolName: string,
    args: Record<string, unknown>,
    toolCalls: DashboardAgentToolCall[],
  ): Promise<T | null> {
    try {
      const result = await this.dashboardAgentMcpService.callTool(toolName, args);
      toolCalls.push({
        tool: `control.${toolName}`,
        ok: true,
        details: summarizeToolResult(toolName, result),
      });
      return result as T;
    } catch (error) {
      toolCalls.push({
        tool: `control.${toolName}`,
        ok: false,
        details: compact(error instanceof Error ? error.message : 'Tool failed', 180),
      });
      return null;
    }
  }

  /**
   * Gets active run id.
   */
  getActiveRunId() {
    return this.activeRunId;
  }

  /**
   * Gets config store.
   */
  private getConfigStore() {
    const delegate = (
      this.prisma as unknown as { dashboardAgentConfig?: DashboardAgentConfigStore }
    ).dashboardAgentConfig;
    if (!delegate) {
      throw new InternalServerErrorException('Dashboard agent config storage is unavailable');
    }
    return delegate;
  }

  /**
   * Gets run store.
   */
  private getRunStore() {
    const delegate = (this.prisma as unknown as { dashboardAgentRun?: DashboardAgentRunStore })
      .dashboardAgentRun;
    if (!delegate) {
      throw new InternalServerErrorException('Dashboard agent run storage is unavailable');
    }
    return delegate;
  }
}

/**
 * Implements rank highlights.
 */
function rankHighlights(highlights: DashboardAgentHighlight[]) {
  return [...highlights].sort((left, right) => {
    const severityDiff = severityRank(right.severity) - severityRank(left.severity);
    if (severityDiff !== 0) {
      return severityDiff;
    }
    if (left.confidence !== right.confidence) {
      return right.confidence - left.confidence;
    }
    return left.title.localeCompare(right.title);
  });
}

/**
 * Implements severity rank.
 */
function severityRank(severity: FindingSeverity) {
  if (severity === 'critical') {
    return 3;
  }
  if (severity === 'warn') {
    return 2;
  }
  return 1;
}

/**
 * Implements map severity.
 */
function mapSeverity(severity: FindingSeverity): EventSeverity {
  if (severity === 'critical') {
    return EventSeverity.ERROR;
  }
  if (severity === 'warn') {
    return EventSeverity.WARN;
  }
  return EventSeverity.INFO;
}

/**
 * Implements normalize run status.
 */
function normalizeRunStatus(value: string | null): RunStatus | null {
  const parsed = dashboardAgentRunStatusSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/**
 * Parses highlights.
 */
function parseHighlights(value: Prisma.JsonValue | null): DashboardAgentHighlight[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = z
    .array(dashboardAgentRunHistoryItemSchema.shape.highlights.unwrap().element)
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Implements strip open ai calls from summary.
 */
function stripOpenAiCallsFromSummary(value: Prisma.JsonValue | null) {
  const summary = toRecord(value);
  if (!summary || !Object.prototype.hasOwnProperty.call(summary, 'openAiCalls')) {
    return value;
  }

  const { openAiCalls: _openAiCalls, ...rest } = summary;
  void _openAiCalls;
  return rest as Prisma.JsonValue;
}

/**
 * Implements extract reasoning summary.
 */
function extractReasoningSummary(output: unknown) {
  if (!Array.isArray(output)) {
    return [] as string[];
  }

  const summaryLines: string[] = [];
  for (const item of output) {
    const record = toRecord(item);
    if (!record || record.type !== 'reasoning' || !Array.isArray(record.summary)) {
      continue;
    }

    for (const part of record.summary) {
      const summaryPart = toRecord(part);
      if (!summaryPart || typeof summaryPart.text !== 'string') {
        continue;
      }
      const sanitized = sanitizeDebugString(
        summaryPart.text,
        OPENAI_DEBUG_REASONING_LINE_MAX,
      ).trim();
      if (!sanitized) {
        continue;
      }
      summaryLines.push(sanitized);
      if (summaryLines.length >= OPENAI_DEBUG_REASONING_LIMIT) {
        return summaryLines;
      }
    }
  }

  return summaryLines;
}

/**
 * Implements to open ai usage snapshot.
 */
function toOpenAiUsageSnapshot(usage: unknown): DashboardAgentOpenAiCall['usage'] {
  const usageRecord = toRecord(usage);
  if (!usageRecord) {
    return null;
  }

  const outputDetails = toRecord(usageRecord.output_tokens_details);
  return {
    inputTokens: toNonNegativeIntOrNull(usageRecord.input_tokens),
    outputTokens: toNonNegativeIntOrNull(usageRecord.output_tokens),
    reasoningTokens: toNonNegativeIntOrNull(outputDetails?.reasoning_tokens),
    totalTokens: toNonNegativeIntOrNull(usageRecord.total_tokens),
  };
}

/**
 * Implements extract top process summary.
 */
function extractTopProcessSummary(raw: Record<string, unknown>) {
  const result = toRecord(raw.result);
  if (!result) {
    return null;
  }

  const processList = Array.isArray(result.processes)
    ? result.processes
    : Array.isArray(result.top)
      ? result.top
      : null;
  if (!processList || processList.length === 0) {
    return null;
  }

  const top = processList
    .slice(0, 3)
    .map((entry) => {
      const record = toRecord(entry);
      if (!record) {
        return null;
      }

      const name =
        typeof record.name === 'string'
          ? record.name
          : typeof record.command === 'string'
            ? record.command
            : 'unknown';
      const cpu =
        coerceNumber(record.cpuPct) ?? coerceNumber(record.cpu) ?? coerceNumber(record.cpuPercent);
      if (cpu === null) {
        return compact(name, 40);
      }
      return `${compact(name, 40)} (${toPercent(cpu)})`;
    })
    .filter((value): value is string => Boolean(value));

  if (top.length === 0) {
    return null;
  }

  return `Top processes: ${top.join(', ')}`;
}

/**
 * Implements transition count.
 */
function transitionCount(states: string[]) {
  let count = 0;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index] !== states[index - 1]) {
      count += 1;
    }
  }
  return count;
}

/**
 * Implements down streak.
 */
function downStreak(history: MonitorHistoryItem[]) {
  let streak = 0;
  for (const item of history) {
    if (item.status !== 'DOWN') {
      break;
    }
    streak += 1;
  }
  return streak;
}

/**
 * Implements median.
 */
function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1];
    const right = sorted[mid];
    if (left === undefined || right === undefined) {
      return null;
    }
    return (left + right) / 2;
  }

  const value = sorted[mid];
  return value === undefined ? null : value;
}

/**
 * Implements most repeated question.
 */
function mostRepeatedQuestion(questions: AiQuestionRecord[]) {
  const counts = new Map<string, { text: string; count: number }>();

  for (const question of questions) {
    const normalized = compactWhitespace(question.text).toLowerCase();
    if (!normalized) {
      continue;
    }

    const existing = counts.get(normalized);
    if (existing) {
      existing.count += 1;
      continue;
    }

    counts.set(normalized, {
      text: question.text,
      count: 1,
    });
  }

  let best: { text: string; count: number } | null = null;
  for (const candidate of counts.values()) {
    if (!best || candidate.count > best.count) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Implements to percent.
 */
function toPercent(value: number) {
  return `${Math.round(value * 10) / 10}%`;
}

/**
 * Implements summarize tool result.
 */
function summarizeToolResult(toolName: string, value: unknown) {
  const record = toRecord(value);
  if (!record) {
    return `${toolName} returned non-object result`;
  }

  switch (toolName) {
    case 'homelab.snapshot':
      return `hosts=${coerceNumber(record.hosts) ?? 0}, monitors=${coerceNumber(record.monitors) ?? 0}`;
    case 'metrics.host.history': {
      const hosts = Array.isArray(record.hosts) ? record.hosts.length : 0;
      return `loaded ${hosts} host metric stream(s)`;
    }
    case 'monitors.results': {
      const monitors = Array.isArray(record.monitors) ? record.monitors.length : 0;
      return `loaded ${monitors} monitor result set(s)`;
    }
    case 'events.recent': {
      const events = Array.isArray(record.events) ? record.events.length : 0;
      return `loaded ${events} event(s)`;
    }
    case 'ai.questions': {
      const questions = Array.isArray(record.questions) ? record.questions.length : 0;
      return `loaded ${questions} question(s)`;
    }
    case 'discovery.runs': {
      const runs = Array.isArray(record.runs) ? record.runs.length : 0;
      return `loaded ${runs} discovery run(s)`;
    }
    default:
      return `${toolName} loaded`;
  }
}

/**
 * Implements compact.
 */
function compact(value: string, maxLength: number) {
  const trimmed = compactWhitespace(value);
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Implements compact whitespace.
 */
function compactWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Implements sanitize debug string.
 */
function sanitizeDebugString(value: string, maxLength = OPENAI_DEBUG_MAX_STRING_LENGTH) {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bauthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi, 'authorization: Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      (_match, key: string) => `${key}=[REDACTED]`,
    );
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Implements sanitize debug value.
 */
function sanitizeDebugValue(value: unknown, depth = 0): Prisma.JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return sanitizeDebugString(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (depth >= OPENAI_DEBUG_MAX_DEPTH) {
    return '[TRUNCATED_DEPTH]';
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, OPENAI_DEBUG_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeDebugValue(entry, depth + 1));
    if (value.length > OPENAI_DEBUG_MAX_ARRAY_ITEMS) {
      items.push(`[TRUNCATED_ITEMS:${value.length - OPENAI_DEBUG_MAX_ARRAY_ITEMS}]`);
    }
    return items;
  }
  if (typeof value !== 'object') {
    return sanitizeDebugString(String(value));
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, Prisma.JsonValue> = {};
  const entries = Object.entries(record).slice(0, OPENAI_DEBUG_MAX_OBJECT_KEYS);
  for (const [key, entry] of entries) {
    if (shouldRedactDebugKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizeDebugValue(entry, depth + 1);
  }

  const truncated = Object.keys(record).length - entries.length;
  if (truncated > 0) {
    output._truncatedKeys = truncated;
  }

  return output;
}

/**
 * Checks whether redact debug key.
 */
function shouldRedactDebugKey(key: string) {
  const normalized = key.toLowerCase();
  return debugSecretKeyMarkers.some((marker) => normalized.includes(marker));
}

/**
 * Checks whether finite number.
 */
function isFiniteNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Implements coerce number.
 */
function coerceNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

/**
 * Implements to non negative int or null.
 */
function toNonNegativeIntOrNull(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : null;
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

/**
 * Implements try parse json record.
 */
function tryParseJsonRecord(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Parses ai refinement response.
 */
function parseAiRefinementResponse(
  value: string,
  draftHighlights: DashboardAgentHighlight[],
): { success: true; data: z.infer<typeof aiRefinementSchema> } | { success: false; error: string } {
  const parsed = tryParseJsonRecord(value);
  if (!parsed) {
    return {
      success: false,
      error: 'Model did not return a parseable JSON object',
    };
  }

  const exact = aiRefinementSchema.safeParse(parsed);
  if (exact.success) {
    return {
      success: true,
      data: exact.data,
    };
  }

  const coerced = coerceAiRefinementPayload(parsed, draftHighlights);
  if (coerced) {
    const normalized = aiRefinementSchema.safeParse(coerced);
    if (normalized.success) {
      return {
        success: true,
        data: normalized.data,
      };
    }
  }

  return {
    success: false,
    error: `Model returned invalid JSON shape: ${summarizeZodIssues(exact.error)}`,
  };
}

/**
 * Implements coerce ai refinement payload.
 */
function coerceAiRefinementPayload(
  value: Record<string, unknown>,
  draftHighlights: DashboardAgentHighlight[],
) {
  const rawHighlights = Array.isArray(value.highlights) ? value.highlights : null;
  if (!rawHighlights) {
    return null;
  }

  const highlights = rawHighlights
    .map((entry, index) => coerceAiRefinementHighlight(entry, index, draftHighlights))
    .filter((entry): entry is DashboardAgentHighlight => entry !== null);

  if (rawHighlights.length > 0 && highlights.length === 0) {
    return null;
  }

  const notes = normalizeStringList(value.notes, 20, 240);
  if (notes.length > 0) {
    return {
      notes,
      highlights,
    };
  }

  return { highlights };
}

/**
 * Implements coerce ai refinement highlight.
 */
function coerceAiRefinementHighlight(
  value: unknown,
  index: number,
  draftHighlights: DashboardAgentHighlight[],
): DashboardAgentHighlight | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const fallback = findDraftHighlightFallback(record, index, draftHighlights);
  const title = normalizeBoundedString(record.title, 160) ?? fallback?.title ?? null;
  const summary = normalizeBoundedString(record.summary, 1200) ?? fallback?.summary ?? null;
  const severity = normalizeDashboardAgentSeverity(record.severity) ?? fallback?.severity ?? null;
  const category = normalizeDashboardAgentCategory(record.category) ?? fallback?.category ?? null;
  const confidence = normalizeConfidence(record.confidence) ?? fallback?.confidence ?? null;

  if (!title || !summary || !severity || !category || confidence === null) {
    return null;
  }

  return {
    id: normalizeBoundedString(record.id, 64) ?? fallback?.id ?? `ai-highlight-${index + 1}`,
    title,
    summary,
    severity,
    category,
    confidence,
    evidence: hasOwn(record, 'evidence')
      ? normalizeStringList(record.evidence, 12, 240)
      : (fallback?.evidence ?? []),
    investigation:
      /**
       * Checks whether own.
       */
      hasOwn(record, 'investigation')
        ? normalizeStringList(record.investigation, 12, 240)
        : (fallback?.investigation ?? []),
    recommendedActions:
      /**
       * Checks whether own.
       */
      hasOwn(record, 'recommendedActions')
        ? normalizeStringList(record.recommendedActions, 8, 240)
        : (fallback?.recommendedActions ?? []),
    references:
      /**
       * Checks whether own.
       */
      hasOwn(record, 'references')
        ? normalizeHighlightReferences(record.references)
        : fallback?.references,
  };
}

/**
 * Implements find draft highlight fallback.
 */
function findDraftHighlightFallback(
  record: Record<string, unknown>,
  index: number,
  draftHighlights: DashboardAgentHighlight[],
) {
  const id = normalizeBoundedString(record.id, 64);
  if (id) {
    const exactIdMatch = draftHighlights.find((highlight) => highlight.id === id);
    if (exactIdMatch) {
      return exactIdMatch;
    }
  }

  const title = normalizeBoundedString(record.title, 160);
  if (title) {
    const normalizedTitle = title.toLowerCase();
    const titleMatch = draftHighlights.find(
      (highlight) => highlight.title.trim().toLowerCase() === normalizedTitle,
    );
    if (titleMatch) {
      return titleMatch;
    }
  }

  return draftHighlights[index] ?? null;
}

/**
 * Implements normalize bounded string.
 */
function normalizeBoundedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = compact(value, maxLength);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Implements normalize string list.
 */
function normalizeStringList(value: unknown, maxItems: number, maxLength: number) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => compact(entry, maxLength))
    .filter((entry) => entry.length > 0)
    .slice(0, maxItems);
}

/**
 * Implements normalize dashboard agent severity.
 */
function normalizeDashboardAgentSeverity(
  value: unknown,
): DashboardAgentHighlight['severity'] | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = compactWhitespace(value).toLowerCase();
  const alias =
    normalized === 'warning'
      ? 'warn'
      : normalized === 'error' || normalized === 'high'
        ? 'critical'
        : normalized === 'low'
          ? 'info'
          : normalized;
  const parsed = dashboardAgentSeveritySchema.safeParse(alias);
  return parsed.success ? parsed.data : null;
}

/**
 * Implements normalize dashboard agent category.
 */
function normalizeDashboardAgentCategory(
  value: unknown,
): DashboardAgentHighlight['category'] | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = compactWhitespace(value)
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  const parsed = dashboardAgentCategorySchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

/**
 * Implements normalize confidence.
 */
function normalizeConfidence(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }

  return null;
}

/**
 * Implements normalize highlight references.
 */
function normalizeHighlightReferences(
  value: unknown,
): DashboardAgentHighlight['references'] | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }

  const hostId = normalizeUuid(record.hostId);
  const monitorId = normalizeUuid(record.monitorId);
  const discoveryRunId = normalizeUuid(record.discoveryRunId);

  if (!hostId && !monitorId && !discoveryRunId) {
    return undefined;
  }

  return {
    ...(hostId ? { hostId } : {}),
    ...(monitorId ? { monitorId } : {}),
    ...(discoveryRunId ? { discoveryRunId } : {}),
  };
}

/**
 * Implements normalize uuid.
 */
function normalizeUuid(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = compactWhitespace(value);
  return z.string().uuid().safeParse(normalized).success ? normalized : null;
}

/**
 * Implements summarize zod issues.
 */
function summarizeZodIssues(error: z.ZodError) {
  if (error.issues.length === 0) {
    return 'schema validation failed';
  }

  return compact(
    error.issues
      .slice(0, 3)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; '),
    480,
  );
}

/**
 * Checks whether own.
 */
function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

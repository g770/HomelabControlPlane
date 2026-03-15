/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements alerts service business logic for the service layer.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertEventStatus,
  AlertRuleType,
  CheckResultStatus,
  EventSeverity,
  HealthStatus,
  type Prisma,
  type AlertEvent,
  type AlertRule,
} from '@prisma/client';
import {
  alertRuleDraftSchema,
  alertRuleSpecSchema,
  type AlertCatalogResponse,
  type AlertComparator,
  type AlertCondition,
  type AlertIncident,
  type AlertParseRequest,
  type AlertParseResponse,
  type AlertPreviewRequest,
  type AlertPreviewResponse,
  type AlertReducer,
  type AlertRuleCreate,
  type AlertRuleDraft,
  type AlertRuleSpec,
  type AlertRuleSummary,
  type AlertRuleUpdate,
  type AlertScope,
  type AlertSilenceCreate,
} from '@homelab/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';

type RuleRecord = Pick<
  AlertRule,
  | 'id'
  | 'name'
  | 'description'
  | 'type'
  | 'specVersion'
  | 'config'
  | 'enabled'
  | 'createdAt'
  | 'updatedAt'
>;

type RuleWithSpec = {
  record: RuleRecord;
  summary: AlertRuleSummary;
};

type HostCandidate = {
  kind: 'host';
  id: string;
  name: string;
  hostId: string;
  host: {
    id: string;
    hostname: string;
    status: HealthStatus;
    cpuPct: number;
    memPct: number;
    diskPct: number;
    lastSeenAt: Date | null;
  };
};

type CheckCandidate = {
  kind: 'check';
  id: string;
  name: string;
  checkId: string;
  hostId?: string;
  serviceId?: string;
  check: {
    id: string;
    name: string;
    hostId: string | null;
    serviceId: string | null;
  };
  host?: {
    id: string;
    hostname: string;
  } | null;
  service?: {
    id: string;
    name: string;
  } | null;
};

type ServiceCandidate = {
  kind: 'service';
  id: string;
  name: string;
  serviceId: string;
  service: {
    id: string;
    name: string;
    status: HealthStatus;
  };
};

type HomelabCandidate = {
  kind: 'homelab';
  id: 'homelab';
  name: 'Homelab';
};

type CandidateEntity = HostCandidate | CheckCandidate | ServiceCandidate | HomelabCandidate;

type LeafResult = {
  key: string;
  matched: boolean;
  noData: boolean;
  message: string;
  value: unknown;
};

type CandidateEvaluation = {
  candidate: CandidateEntity;
  fingerprint: string;
  groupKey: string;
  matched: boolean;
  noData: boolean;
  message: string;
  values: Record<string, unknown>;
  labels: Record<string, string>;
  severity: EventSeverity;
};

type EvaluationSummary = {
  candidateCount: number;
  evaluations: CandidateEvaluation[];
};

type HostFactPoint = {
  createdAt: Date;
  snapshot: unknown;
};

type CheckResultPoint = {
  checkedAt: Date;
  status: CheckResultStatus;
  latencyMs: number | null;
  httpStatus: number | null;
};

type ActiveSilence = {
  id: string;
  targetType: string;
  targetId: string;
};

type DraftWithMetadata = {
  draft: AlertRuleDraft;
  rationale: string | null;
  confidence: number | null;
};

type ParseReferences = {
  hosts: Array<{ id: string; hostname: string; tags: string[] }>;
  services: Array<{ id: string; name: string }>;
  checks: Array<{ id: string; name: string; target: string }>;
  routes: Array<{ id: string; name: string; type: string }>;
  validHostIds: Set<string>;
  validServiceIds: Set<string>;
  validCheckIds: Set<string>;
  validRouteIds: Set<string>;
};

type PreviewIncident = AlertPreviewResponse['incidents'][number];

type IncidentRecord = AlertEvent & {
  rule: {
    name: string;
  };
  host: {
    id: string;
    hostname: string;
  } | null;
  service: {
    id: string;
    name: string;
  } | null;
  check: {
    id: string;
    name: string;
  } | null;
};

type EvaluationCache = {
  hostFacts: Map<string, HostFactPoint[]>;
  checkResults: Map<string, CheckResultPoint[]>;
  eventCounts: Map<string, number>;
  homelabMetrics: Map<string, number>;
};

const OPEN_ALERT_STATUSES = [AlertEventStatus.PENDING, AlertEventStatus.FIRING];

const defaultRuleDraft: AlertRuleDraft = {
  name: 'CPU saturation',
  description: 'Alert when any host stays above 85% CPU for 5 minutes.',
  enabled: false,
  spec: {
    scope: {
      entity: 'host',
    },
    conditions: {
      match: 'ALL',
      items: [
        {
          kind: 'host_metric',
          metric: 'cpuPct',
          comparator: 'GT',
          threshold: 85,
          reducer: 'latest',
          windowMinutes: 5,
        },
      ],
    },
    evaluation: {
      pendingMinutes: 5,
      recoveryMinutes: 5,
      noDataBehavior: 'KEEP_STATE',
    },
    severity: 'WARN',
    labels: {},
    delivery: {
      routeIds: [],
      repeatMinutes: 60,
      sendResolved: true,
    },
  },
};

const hostMetricCatalog: AlertCatalogResponse['hostMetrics'] = [
  {
    id: 'cpuPct',
    label: 'CPU %',
    description: 'CPU utilization percentage over the evaluation window.',
  },
  {
    id: 'memPct',
    label: 'Memory %',
    description: 'Memory utilization percentage over the evaluation window.',
  },
  {
    id: 'diskPct',
    label: 'Disk %',
    description: 'Disk utilization percentage over the evaluation window.',
  },
  {
    id: 'networkKbps',
    label: 'Network KB/s',
    description: 'Network throughput in kilobytes per second.',
  },
  { id: 'diskIoOps', label: 'Disk IOPS', description: 'Disk I/O operations per second.' },
];

const homelabMetricCatalog: AlertCatalogResponse['homelabMetrics'] = [
  { id: 'hostsOnline', label: 'Hosts online' },
  { id: 'hostsOffline', label: 'Hosts offline' },
  { id: 'activeAlerts', label: 'Active alerts' },
  { id: 'failingChecks', label: 'Failing checks' },
];

const stateTargetCatalog: AlertCatalogResponse['stateTargets'] = [
  { id: 'host_offline', label: 'Host offline' },
  { id: 'service_unhealthy', label: 'Service unhealthy' },
  { id: 'check_down', label: 'Check down' },
];

const checkModeCatalog: AlertCatalogResponse['checkModes'] = [
  { id: 'consecutive_failures', label: 'Consecutive failures' },
  { id: 'failures_in_window', label: 'Failures in window' },
  { id: 'latency_gt', label: 'Latency above threshold' },
  { id: 'http_status_not', label: 'HTTP status mismatch' },
];

const aiAlertDraftEnvelopeSchema = z.union([
  alertRuleDraftSchema,
  z
    .object({
      draft: alertRuleDraftSchema,
      rationale: z.string().min(1).max(500).optional(),
      confidence: z.number().int().min(0).max(100).optional(),
    })
    .strict(),
]);

@Injectable()
/**
 * Implements the alerts service class.
 */
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private evaluationInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: EventsService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly aiProviderService: AiProviderService,
  ) {}

  /**
   * Handles active.
   */
  async active() {
    /**
     * Implements incidents.
     */
    const incidents = (await this.listIncidents()).incidents.filter(
      (incident) => incident.state !== AlertEventStatus.RESOLVED,
    );
    return incidents.map((incident) => ({
      id: incident.id,
      message: incident.message,
      ruleId: incident.ruleId,
      rule: {
        name: incident.ruleName,
      },
    }));
  }

  /**
   * Lists incidents for the surrounding workflow.
   */
  async listIncidents(): Promise<{ incidents: AlertIncident[] }> {
    const incidents = await this.prisma.alertEvent.findMany({
      include: {
        rule: {
          select: {
            name: true,
          },
        },
        host: {
          select: {
            id: true,
            hostname: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
        check: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    incidents.sort((left, right) => {
      const leftResolved = left.status === AlertEventStatus.RESOLVED ? 1 : 0;
      const rightResolved = right.status === AlertEventStatus.RESOLVED ? 1 : 0;
      if (leftResolved !== rightResolved) {
        return leftResolved - rightResolved;
      }
      const severityRank = severityOrder(right.severity) - severityOrder(left.severity);
      if (severityRank !== 0) {
        return severityRank;
      }
      return right.startedAt.getTime() - left.startedAt.getTime();
    });

    return {
      incidents: incidents.map((incident) => toIncidentSummary(incident)),
    };
  }

  /**
   * Implements the rules workflow for this file.
   */
  async rules(): Promise<{ rules: AlertRuleSummary[] }> {
    const rules = await this.prisma.alertRule.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return {
      rules: rules.map((rule) => this.normalizeRule(rule).summary),
    };
  }

  /**
   * Handles legacy rules.
   */
  async legacyRules() {
    const rules = await this.rules();
    return rules.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      type: rule.type,
      config: rule.spec,
      enabled: rule.enabled,
    }));
  }

  /**
   * Implements the catalog workflow for this file.
   */
  async catalog(): Promise<AlertCatalogResponse> {
    const [routes, hosts, services, checks] = await Promise.all([
      this.prisma.notificationRoute.findMany({
        where: { enabled: true },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          type: true,
        },
      }),
      this.prisma.host.findMany({
        orderBy: { hostname: 'asc' },
        select: {
          id: true,
          hostname: true,
          resolvedPrimaryIp: true,
        },
      }),
      this.prisma.service.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
        },
      }),
      this.prisma.check.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          hostId: true,
          serviceId: true,
        },
      }),
    ]);

    return {
      scopes: ['host', 'check', 'service', 'homelab'],
      matchModes: ['ALL', 'ANY'],
      comparators: ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'],
      reducers: ['latest', 'avg', 'min', 'max'],
      hostMetrics: hostMetricCatalog,
      homelabMetrics: homelabMetricCatalog,
      stateTargets: stateTargetCatalog,
      checkModes: checkModeCatalog,
      notificationRoutes: routes.map((route) => ({
        id: route.id,
        name: route.name,
        type: route.type,
      })),
      hosts: hosts.map((host) => ({
        id: host.id,
        hostname: host.hostname,
        hostIp: host.resolvedPrimaryIp,
      })),
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
      })),
      checks: checks.map((check) => ({
        id: check.id,
        name: check.name,
        hostId: check.hostId,
        serviceId: check.serviceId,
      })),
      ruleDefaults: defaultRuleDraft,
    };
  }

  /**
   * Creates rule.
   */
  async createRule(userId: string, body: AlertRuleCreate) {
    const created = await this.prisma.alertRule.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        type: AlertRuleType.RULE_ENGINE,
        specVersion: 1,
        enabled: body.enabled,
        config: body.spec as Prisma.InputJsonValue,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'alert_rule.create',
      targetType: 'alert_rule',
      targetId: created.id,
      paramsJson: {
        name: body.name,
        enabled: body.enabled,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return this.normalizeRule(created).summary;
  }

  /**
   * Handles update rule.
   */
  async updateRule(userId: string, id: string, body: AlertRuleUpdate) {
    const updated = await this.prisma.alertRule.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        enabled: body.enabled,
        type: body.spec ? AlertRuleType.RULE_ENGINE : undefined,
        specVersion: body.spec ? 1 : undefined,
        config: body.spec ? (body.spec as Prisma.InputJsonValue) : undefined,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'alert_rule.update',
      targetType: 'alert_rule',
      targetId: id,
      paramsJson: {
        name: body.name,
        enabled: body.enabled,
        descriptionChanged: body.description !== undefined,
        specChanged: body.spec !== undefined,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return this.normalizeRule(updated).summary;
  }

  /**
   * Handles remove rule.
   */
  async removeRule(userId: string, id: string) {
    await this.prisma.alertRule.delete({
      where: { id },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'alert_rule.delete',
      targetType: 'alert_rule',
      targetId: id,
      success: true,
    });

    return { ok: true };
  }

  /**
   * Handles acknowledge incident.
   */
  async acknowledgeIncident(userId: string, incidentId: string) {
    const incident = await this.prisma.alertEvent.findUnique({
      where: { id: incidentId },
      include: {
        rule: {
          select: {
            name: true,
          },
        },
        host: {
          select: {
            id: true,
            hostname: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
        check: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    if (!incident) {
      throw new NotFoundException('Alert incident not found');
    }

    const acknowledged = await this.prisma.alertEvent.update({
      where: { id: incidentId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId,
      },
      include: {
        rule: {
          select: {
            name: true,
          },
        },
        host: {
          select: {
            id: true,
            hostname: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
        check: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'alert_incident.ack',
      targetType: 'alert_event',
      targetId: incidentId,
      success: true,
    });

    return toIncidentSummary(acknowledged);
  }

  /**
   * Creates silence.
   */
  async createSilence(userId: string, body: AlertSilenceCreate) {
    const silence = await this.prisma.silence.create({
      data: {
        targetType: body.targetType,
        targetId: body.targetId,
        reason: body.reason,
        startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
        endsAt: new Date(body.endsAt),
        createdByUserId: userId,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'silence.create',
      targetType: 'silence',
      targetId: silence.id,
      paramsJson: {
        targetType: body.targetType,
        targetId: body.targetId,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return silence;
  }

  /**
   * Handles delete silence.
   */
  async deleteSilence(userId: string, id: string) {
    await this.prisma.silence.delete({
      where: { id },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'silence.delete',
      targetType: 'silence',
      targetId: id,
      success: true,
    });

    return { ok: true };
  }

  /**
   * Implements the preview rule workflow for this file.
   */
  async previewRule(body: AlertPreviewRequest): Promise<AlertPreviewResponse> {
    const now = new Date();
    const evaluated = await this.evaluateDraft(body.rule, now);
    const incidents = evaluated.evaluations
      .filter((evaluation) => evaluation.matched)
      .map((evaluation) => this.toPreviewIncident(evaluation, body.rule));

    return {
      evaluatedAt: now.toISOString(),
      summary: {
        candidateCount: evaluated.candidateCount,
        matchedCount: incidents.length,
        firingCount: incidents.filter((incident) => incident.state === 'FIRING').length,
        pendingCount: incidents.filter((incident) => incident.state === 'PENDING').length,
      },
      incidents,
    };
  }

  async parseRuleDescription(
    _userId: string,
    input: AlertParseRequest,
  ): Promise<AlertParseResponse> {
    const references = await this.loadParseReferences();
    const fallback = this.buildHeuristicDraft(input, references);
    const openai = await this.aiProviderService.getClient();
    if (!openai) {
      return {
        aiEnabled: false,
        generatedByAi: false,
        warnings: ['AI is disabled. Parsed using heuristics.'],
        rationale: fallback.rationale,
        confidence: fallback.confidence,
        draft: fallback.draft,
      };
    }

    try {
      const response = await openai.responses.create({
        model: this.aiProviderService.getModel(),
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: [
                  'You convert operator English into structured alert-rule drafts.',
                  'Return valid JSON only and no markdown.',
                  'Use the draft shape exactly.',
                  JSON.stringify({
                    draft: {
                      name: 'CPU saturation',
                      description: 'Alert when any host stays above 85% CPU for 5 minutes.',
                      enabled: false,
                      spec: defaultRuleDraft.spec,
                    },
                    rationale: 'One sentence explanation.',
                    confidence: 0,
                  }),
                  'Keep drafts disabled.',
                  'Only use entity ids supplied in the context.',
                  'Use routeIds only when a route is explicitly referenced in the request or context.',
                ].join(' '),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  description: input.description,
                  selectedHostId: input.hostId ?? null,
                  selectedServiceId: input.serviceId ?? null,
                  selectedCheckId: input.checkId ?? null,
                  knownHosts: references.hosts.slice(0, 80),
                  knownServices: references.services.slice(0, 80),
                  knownChecks: references.checks.slice(0, 80),
                  notificationRoutes: references.routes.slice(0, 40),
                  fallbackDraft: fallback,
                }),
              },
            ],
          },
        ],
      });

      const parsed = parseAiAlertDraft(response.output_text ?? '');
      if (!parsed) {
        return {
          aiEnabled: true,
          generatedByAi: false,
          warnings: ['AI response could not be parsed. Parsed using heuristics.'],
          rationale: fallback.rationale,
          confidence: fallback.confidence,
          draft: fallback.draft,
        };
      }

      const sanitized = this.sanitizeDraft(parsed.draft, references, fallback.draft);
      return {
        aiEnabled: true,
        generatedByAi: true,
        warnings: [],
        rationale: parsed.rationale ?? fallback.rationale,
        confidence: parsed.confidence ?? fallback.confidence,
        draft: sanitized,
      };
    } catch {
      return {
        aiEnabled: true,
        generatedByAi: false,
        warnings: ['AI parse failed. Parsed using heuristics.'],
        rationale: fallback.rationale,
        confidence: fallback.confidence,
        draft: fallback.draft,
      };
    }
  }

  /**
   * Handles trigger scheduled run if due.
   */
  async triggerScheduledRunIfDue() {
    if (this.evaluationInFlight) {
      return { skipped: true };
    }

    this.evaluationInFlight = true;
    try {
      return await this.evaluateEnabledRules();
    } finally {
      this.evaluationInFlight = false;
    }
  }

  /**
   * Handles evaluate enabled rules.
   */
  async evaluateEnabledRules() {
    const now = new Date();
    const activeSilences = await this.prisma.silence.findMany({
      where: {
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      select: {
        id: true,
        targetType: true,
        targetId: true,
      },
    });

    const rules = await this.prisma.alertRule.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const rule of rules) {
      if (
        rule.type === AlertRuleType.RULE_ENGINE &&
        !alertRuleSpecSchema.safeParse(rule.config).success
      ) {
        this.logger.warn(`Skipping invalid rule-engine alert rule ${rule.id}`);
        continue;
      }
      const normalized = this.normalizeRule(rule);
      const draft: AlertRuleDraft = {
        name: normalized.summary.name,
        description: normalized.summary.description ?? undefined,
        enabled: normalized.summary.enabled,
        spec: normalized.summary.spec,
      };
      const evaluated = await this.evaluateDraft(draft, now);
      await this.persistEvaluation(normalized, draft, evaluated, now, activeSilences);
    }

    return {
      evaluated: rules.length,
      evaluatedAt: now.toISOString(),
    };
  }

  /**
   * Normalizes rule before the caller uses it.
   */
  private normalizeRule(rule: RuleRecord): RuleWithSpec {
    const spec = normalizeRuleSpec(rule, this.logger);

    return {
      record: rule,
      summary: {
        id: rule.id,
        name: rule.name,
        description: rule.description ?? null,
        enabled: rule.enabled,
        specVersion: rule.specVersion,
        type: rule.type,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
        spec,
      },
    };
  }

  /**
   * Implements the evaluate draft workflow for this file.
   */
  private async evaluateDraft(draft: AlertRuleDraft, now: Date): Promise<EvaluationSummary> {
    const cache: EvaluationCache = {
      hostFacts: new Map(),
      checkResults: new Map(),
      eventCounts: new Map(),
      homelabMetrics: new Map(),
    };
    const candidates = await this.loadCandidates(draft.spec.scope);
    const evaluations: CandidateEvaluation[] = [];

    for (const candidate of candidates) {
      const leafResults: LeafResult[] = [];
      for (let index = 0; index < draft.spec.conditions.items.length; index += 1) {
        const condition = draft.spec.conditions.items[index];
        if (!condition) {
          continue;
        }
        leafResults.push(await this.evaluateCondition(condition, candidate, now, cache, index));
      }

      const matchedBase =
        draft.spec.conditions.match === 'ALL'
          ? leafResults.every((result) => result.matched)
          : leafResults.some((result) => result.matched);
      const noData = leafResults.some((result) => result.noData) && !matchedBase;
      const matched =
        noData && draft.spec.evaluation.noDataBehavior === 'ALERT' ? true : matchedBase;
      const matchedMessages = leafResults
        .filter((result) => result.matched)
        .map((result) => result.message);
      const noDataMessages = leafResults
        .filter((result) => result.noData)
        .map((result) => result.message);
      const message = matched
        ? matchedMessages.join('; ') || `Rule ${draft.name} matched`
        : noData
          ? noDataMessages.join('; ') || `No data for ${candidate.name}`
          : `Rule ${draft.name} is clear for ${candidate.name}`;
      const values = Object.fromEntries(leafResults.map((result) => [result.key, result.value]));

      evaluations.push({
        candidate,
        fingerprint: buildFingerprint(draft.name, draft.spec.scope.entity, candidate.id),
        groupKey: `${draft.spec.scope.entity}:${candidate.id}`,
        matched,
        noData,
        message,
        values,
        labels: draft.spec.labels,
        severity: draft.spec.severity,
      });
    }

    return {
      candidateCount: candidates.length,
      evaluations,
    };
  }

  /**
   * Loads candidates for the surrounding workflow.
   */
  private async loadCandidates(scope: AlertScope): Promise<CandidateEntity[]> {
    if (scope.entity === 'host') {
      const hosts = await this.prisma.host.findMany({
        where: {
          id: scope.hostIds?.length ? { in: scope.hostIds } : undefined,
          tags: scope.tags?.length ? { hasSome: scope.tags } : undefined,
        },
        orderBy: { hostname: 'asc' },
        select: {
          id: true,
          hostname: true,
          status: true,
          cpuPct: true,
          memPct: true,
          diskPct: true,
          lastSeenAt: true,
        },
      });

      return hosts.map((host) => ({
        kind: 'host',
        id: host.id,
        name: host.hostname,
        hostId: host.id,
        host,
      }));
    }

    if (scope.entity === 'check') {
      const checks = await this.prisma.check.findMany({
        where: {
          id: scope.checkIds?.length ? { in: scope.checkIds } : undefined,
          hostId: scope.hostIds?.length ? { in: scope.hostIds } : undefined,
          serviceId: scope.serviceIds?.length ? { in: scope.serviceIds } : undefined,
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          hostId: true,
          serviceId: true,
          host: {
            select: {
              id: true,
              hostname: true,
            },
          },
          service: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      return checks.map((check) => ({
        kind: 'check',
        id: check.id,
        name: check.name,
        checkId: check.id,
        hostId: check.hostId ?? undefined,
        serviceId: check.serviceId ?? undefined,
        check: {
          id: check.id,
          name: check.name,
          hostId: check.hostId,
          serviceId: check.serviceId,
        },
        host: check.host,
        service: check.service,
      }));
    }

    if (scope.entity === 'service') {
      const services = await this.prisma.service.findMany({
        where: {
          id: scope.serviceIds?.length ? { in: scope.serviceIds } : undefined,
          instances: scope.hostIds?.length
            ? {
                some: {
                  hostId: {
                    in: scope.hostIds,
                  },
                },
              }
            : undefined,
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          status: true,
        },
      });

      return services.map((service) => ({
        kind: 'service',
        id: service.id,
        name: service.name,
        serviceId: service.id,
        service,
      }));
    }

    return [
      {
        kind: 'homelab',
        id: 'homelab',
        name: 'Homelab',
      },
    ];
  }

  private async evaluateCondition(
    condition: AlertCondition,
    candidate: CandidateEntity,
    now: Date,
    cache: EvaluationCache,
    index: number,
  ): Promise<LeafResult> {
    if (condition.kind === 'host_metric') {
      return this.evaluateHostMetricCondition(condition, candidate, now, cache, index);
    }
    if (condition.kind === 'homelab_metric') {
      return this.evaluateHomelabMetricCondition(condition, candidate, now, cache, index);
    }
    if (condition.kind === 'check') {
      return this.evaluateCheckCondition(condition, candidate, cache, index);
    }
    if (condition.kind === 'state') {
      return this.evaluateStateCondition(condition, candidate, now, cache, index);
    }
    return this.evaluateEventCountCondition(condition, candidate, now, cache, index);
  }

  private async evaluateHostMetricCondition(
    condition: Extract<AlertCondition, { kind: 'host_metric' }>,
    candidate: CandidateEntity,
    now: Date,
    cache: EvaluationCache,
    index: number,
  ): Promise<LeafResult> {
    if (candidate.kind !== 'host') {
      return {
        key: `condition_${index + 1}`,
        matched: false,
        noData: true,
        message: 'Host metric conditions require a host scope',
        value: null,
      };
    }

    const value = await this.resolveHostMetric(
      candidate,
      condition.metric,
      condition.reducer,
      condition.windowMinutes,
      now,
      cache,
    );
    if (value === null) {
      return {
        key: `condition_${index + 1}`,
        matched: false,
        noData: true,
        message: `No ${condition.metric} data for ${candidate.name}`,
        value: null,
      };
    }

    return {
      key: `condition_${index + 1}`,
      matched: compareNumbers(value, condition.comparator, condition.threshold),
      noData: false,
      message: `${candidate.name} ${condition.metric} ${formatComparator(condition.comparator)} ${formatMetricValue(
        condition.metric,
        value,
      )} (threshold ${condition.threshold})`,
      value,
    };
  }

  private async evaluateHomelabMetricCondition(
    condition: Extract<AlertCondition, { kind: 'homelab_metric' }>,
    _candidate: CandidateEntity,
    _now: Date,
    cache: EvaluationCache,
    index: number,
  ): Promise<LeafResult> {
    const value = await this.resolveHomelabMetric(condition.metric, cache);

    return {
      key: `condition_${index + 1}`,
      matched: compareNumbers(value, condition.comparator, condition.threshold),
      noData: false,
      message: `Homelab ${condition.metric} ${formatComparator(condition.comparator)} ${value} (threshold ${condition.threshold})`,
      value,
    };
  }

  private async evaluateCheckCondition(
    condition: Extract<AlertCondition, { kind: 'check' }>,
    candidate: CandidateEntity,
    cache: EvaluationCache,
    index: number,
  ): Promise<LeafResult> {
    if (candidate.kind !== 'check') {
      return {
        key: `condition_${index + 1}`,
        matched: false,
        noData: true,
        message: 'Check conditions require a check scope',
        value: null,
      };
    }

    const limit = Math.max(
      condition.sampleSize ?? condition.threshold ?? 1,
      condition.threshold ?? 1,
      1,
    );
    const results = await this.getCheckResults(candidate.checkId, limit, cache);
    if (results.length === 0) {
      return {
        key: `condition_${index + 1}`,
        matched: false,
        noData: true,
        message: `No check results for ${candidate.name}`,
        value: null,
      };
    }

    if (condition.mode === 'consecutive_failures') {
      const threshold = Math.max(condition.threshold ?? 1, 1);
      const targetStatus = condition.status ?? 'DOWN';
      const sample = results.slice(0, threshold);
      const matched =
        sample.length >= threshold && sample.every((result) => result.status === targetStatus);
      return {
        key: `condition_${index + 1}`,
        matched,
        noData: false,
        message: `${candidate.name} has ${sample.filter((result) => result.status === targetStatus).length}/${threshold} recent ${targetStatus.toLowerCase()} results`,
        value: sample.map((result) => result.status),
      };
    }

    if (condition.mode === 'failures_in_window') {
      const threshold = Math.max(condition.threshold ?? 1, 1);
      const targetStatus = condition.status ?? 'DOWN';
      const sampleSize = Math.max(condition.sampleSize ?? threshold, threshold);
      const sample = results.slice(0, sampleSize);
      const failures = sample.filter((result) => result.status === targetStatus).length;
      return {
        key: `condition_${index + 1}`,
        matched: failures >= threshold,
        noData: false,
        message: `${candidate.name} has ${failures}/${sampleSize} ${targetStatus.toLowerCase()} results`,
        value: failures,
      };
    }

    if (condition.mode === 'latency_gt') {
      const latest = results[0];
      const latency = latest?.latencyMs ?? null;
      return {
        key: `condition_${index + 1}`,
        matched: latency !== null && compareNumbers(latency, 'GT', condition.threshold ?? 0),
        noData: latency === null,
        message:
          latency === null
            ? `No latency data for ${candidate.name}`
            : `${candidate.name} latency is ${latency}ms`,
        value: latency,
      };
    }

    const latest = results[0];
    const httpStatus = latest?.httpStatus ?? null;
    return {
      key: `condition_${index + 1}`,
      matched: httpStatus !== null && httpStatus !== (condition.expectedStatus ?? 200),
      noData: httpStatus === null,
      message:
        httpStatus === null
          ? `No HTTP status data for ${candidate.name}`
          : `${candidate.name} returned HTTP ${httpStatus}`,
      value: httpStatus,
    };
  }

  private async evaluateStateCondition(
    condition: Extract<AlertCondition, { kind: 'state' }>,
    candidate: CandidateEntity,
    now: Date,
    cache: EvaluationCache,
    index: number,
  ): Promise<LeafResult> {
    if (condition.target === 'host_offline') {
      if (candidate.kind !== 'host') {
        return {
          key: `condition_${index + 1}`,
          matched: false,
          noData: true,
          message: 'Host offline conditions require a host scope',
          value: null,
        };
      }

      const staleMinutes = Math.max(condition.staleMinutes ?? 2, 1);
      const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
      const matched = !candidate.host.lastSeenAt || candidate.host.lastSeenAt < cutoff;
      return {
        key: `condition_${index + 1}`,
        matched,
        noData: false,
        message: `${candidate.name} heartbeat is ${matched ? 'stale' : 'fresh'}`,
        value: candidate.host.lastSeenAt ? candidate.host.lastSeenAt.toISOString() : null,
      };
    }

    if (condition.target === 'service_unhealthy') {
      if (candidate.kind !== 'service') {
        return {
          key: `condition_${index + 1}`,
          matched: false,
          noData: true,
          message: 'Service health conditions require a service scope',
          value: null,
        };
      }

      return {
        key: `condition_${index + 1}`,
        matched: candidate.service.status !== HealthStatus.OK,
        noData: false,
        message: `${candidate.name} status is ${candidate.service.status}`,
        value: candidate.service.status,
      };
    }

    if (candidate.kind !== 'check') {
      return {
        key: `condition_${index + 1}`,
        matched: false,
        noData: true,
        message: 'Check state conditions require a check scope',
        value: null,
      };
    }

    const latest = (await this.getCheckResults(candidate.checkId, 1, cache))[0];
    return {
      key: `condition_${index + 1}`,
      matched: latest?.status === CheckResultStatus.DOWN,
      noData: !latest,
      message: latest
        ? `${candidate.name} latest status is ${latest.status}`
        : `No check results for ${candidate.name}`,
      value: latest?.status ?? null,
    };
  }

  private async evaluateEventCountCondition(
    condition: Extract<AlertCondition, { kind: 'event_count' }>,
    candidate: CandidateEntity,
    now: Date,
    cache: EvaluationCache,
    index: number,
  ): Promise<LeafResult> {
    const cutoff = new Date(now.getTime() - condition.windowMinutes * 60_000);
    const key = JSON.stringify({
      candidate: candidate.kind,
      id: candidate.id,
      cutoff: cutoff.toISOString(),
      eventType: condition.eventType ?? null,
      severity: condition.severity ?? null,
    });

    let count = cache.eventCounts.get(key);
    if (count === undefined) {
      count = await this.prisma.event.count({
        where: {
          createdAt: {
            gte: cutoff,
          },
          type: condition.eventType,
          severity: condition.severity,
          hostId:
            candidate.kind === 'host'
              ? candidate.hostId
              : candidate.kind === 'check'
                ? candidate.hostId
                : undefined,
          serviceId:
            candidate.kind === 'service'
              ? candidate.serviceId
              : candidate.kind === 'check'
                ? candidate.serviceId
                : undefined,
          checkId: candidate.kind === 'check' ? candidate.checkId : undefined,
        },
      });
      cache.eventCounts.set(key, count);
    }

    const resolvedCount = count ?? 0;

    return {
      key: `condition_${index + 1}`,
      matched: compareNumbers(resolvedCount, condition.comparator, condition.threshold),
      noData: false,
      message: `${candidate.name} has ${resolvedCount} matching events in the last ${condition.windowMinutes} minutes`,
      value: resolvedCount,
    };
  }

  private async resolveHostMetric(
    candidate: HostCandidate,
    metric: Extract<AlertCondition, { kind: 'host_metric' }>['metric'],
    reducer: AlertReducer,
    windowMinutes: number | undefined,
    now: Date,
    cache: EvaluationCache,
  ): Promise<number | null> {
    if (
      reducer === 'latest' &&
      (metric === 'cpuPct' || metric === 'memPct' || metric === 'diskPct')
    ) {
      return candidate.host[metric];
    }

    const lookbackMinutes = Math.max(windowMinutes ?? 15, 1);
    const facts = await this.getHostFacts(candidate.hostId, lookbackMinutes, cache, now);
    if (facts.length === 0) {
      return null;
    }

    const values = facts
      .map((fact) => readHostFactMetric(fact.snapshot, metric))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (values.length === 0) {
      return null;
    }

    if (reducer === 'latest') {
      return values.at(-1) ?? null;
    }
    if (reducer === 'avg') {
      return values.reduce((total, value) => total + value, 0) / values.length;
    }
    if (reducer === 'min') {
      return Math.min(...values);
    }
    return Math.max(...values);
  }

  private async resolveHomelabMetric(
    metric: Extract<AlertCondition, { kind: 'homelab_metric' }>['metric'],
    cache: EvaluationCache,
  ) {
    const cached = cache.homelabMetrics.get(metric);
    if (cached !== undefined) {
      return cached;
    }

    let value = 0;
    if (metric === 'hostsOnline') {
      value = await this.prisma.host.count({
        where: {
          status: HealthStatus.OK,
        },
      });
    } else if (metric === 'hostsOffline') {
      value = await this.prisma.host.count({
        where: {
          status: {
            not: HealthStatus.OK,
          },
        },
      });
    } else if (metric === 'activeAlerts') {
      value = await this.prisma.alertEvent.count({
        where: {
          status: {
            in: OPEN_ALERT_STATUSES,
          },
        },
      });
    } else {
      value = await this.prisma.check.count({
        where: {
          results: {
            some: {
              status: CheckResultStatus.DOWN,
            },
          },
        },
      });
    }

    cache.homelabMetrics.set(metric, value);
    return value;
  }

  /**
   * Gets host facts.
   */
  private async getHostFacts(
    hostId: string,
    windowMinutes: number,
    cache: EvaluationCache,
    now: Date,
  ) {
    const key = `${hostId}:${windowMinutes}`;
    const cached = cache.hostFacts.get(key);
    if (cached) {
      return cached;
    }

    const facts = await this.prisma.hostFact.findMany({
      where: {
        hostId,
        createdAt: {
          gte: new Date(now.getTime() - windowMinutes * 60_000),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 240,
      select: {
        createdAt: true,
        snapshot: true,
      },
    });
    cache.hostFacts.set(key, facts);
    return facts;
  }

  /**
   * Gets check results.
   */
  private async getCheckResults(checkId: string, limit: number, cache: EvaluationCache) {
    const key = `${checkId}:${limit}`;
    const cached = cache.checkResults.get(key);
    if (cached) {
      return cached;
    }

    const results = await this.prisma.checkResult.findMany({
      where: {
        checkId,
      },
      orderBy: { checkedAt: 'desc' },
      take: limit,
      select: {
        checkedAt: true,
        status: true,
        latencyMs: true,
        httpStatus: true,
      },
    });
    cache.checkResults.set(key, results);
    return results;
  }

  private async persistEvaluation(
    normalized: RuleWithSpec,
    draft: AlertRuleDraft,
    evaluated: EvaluationSummary,
    now: Date,
    silences: ActiveSilence[],
  ) {
    const existingIncidents = await this.prisma.alertEvent.findMany({
      where: {
        ruleId: normalized.record.id,
      },
      include: {
        rule: {
          select: {
            name: true,
          },
        },
        host: {
          select: {
            id: true,
            hostname: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
        check: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    const existingByFingerprint = new Map(
      existingIncidents.map((incident) => [incident.fingerprint, incident]),
    );
    const seenFingerprints = new Set<string>();

    for (const evaluation of evaluated.evaluations) {
      const fingerprint = buildFingerprint(
        normalized.record.id,
        draft.spec.scope.entity,
        evaluation.candidate.id,
      );
      seenFingerprints.add(fingerprint);
      const existing = existingByFingerprint.get(fingerprint);

      if (evaluation.matched) {
        const persisted = await this.upsertOpenIncident(
          normalized,
          draft,
          evaluation,
          existing ?? null,
          fingerprint,
          now,
        );
        await this.maybeEmitAndNotify(
          normalized,
          draft,
          persisted,
          existing ?? null,
          silences,
          now,
        );
        continue;
      }

      if (existing && OPEN_ALERT_STATUSES.includes(existing.status)) {
        const shouldKeepOpen =
          (evaluation.noData && draft.spec.evaluation.noDataBehavior === 'KEEP_STATE') ||
          shouldKeepOpenForRecovery(existing, draft.spec, now);

        if (shouldKeepOpen) {
          await this.prisma.alertEvent.update({
            where: { id: existing.id },
            data: {
              lastEvaluatedAt: now,
            },
          });
          continue;
        }

        await this.resolveIncident(existing, draft, now, silences);
      }
    }

    for (const incident of existingIncidents) {
      if (seenFingerprints.has(incident.fingerprint)) {
        continue;
      }
      if (!OPEN_ALERT_STATUSES.includes(incident.status)) {
        continue;
      }
      await this.resolveIncident(incident, draft, now, silences);
    }
  }

  private async upsertOpenIncident(
    normalized: RuleWithSpec,
    draft: AlertRuleDraft,
    evaluation: CandidateEvaluation,
    existing: IncidentRecord | null,
    fingerprint: string,
    now: Date,
  ) {
    const pendingMs = draft.spec.evaluation.pendingMinutes * 60_000;
    const openedAt =
      existing && existing.status !== AlertEventStatus.RESOLVED ? existing.startedAt : now;
    const nextStatus =
      pendingMs > 0 && now.getTime() - openedAt.getTime() < pendingMs
        ? AlertEventStatus.PENDING
        : AlertEventStatus.FIRING;
    const entityRefs = candidateRefs(evaluation.candidate);

    if (existing) {
      return this.prisma.alertEvent.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          severity: evaluation.severity,
          message: evaluation.message,
          groupKey: evaluation.groupKey,
          labels: evaluation.labels as Prisma.InputJsonValue,
          lastValue: evaluation.values as Prisma.InputJsonValue,
          hostId: entityRefs.hostId,
          serviceId: entityRefs.serviceId,
          checkId: entityRefs.checkId,
          startedAt: existing.status === AlertEventStatus.RESOLVED ? now : existing.startedAt,
          lastMatchedAt: now,
          lastEvaluatedAt: now,
          resolvedAt: null,
          acknowledgedAt:
            existing.status === AlertEventStatus.RESOLVED ? null : existing.acknowledgedAt,
          acknowledgedByUserId:
            existing.status === AlertEventStatus.RESOLVED ? null : existing.acknowledgedByUserId,
        },
        include: {
          rule: {
            select: {
              name: true,
            },
          },
          host: {
            select: {
              id: true,
              hostname: true,
            },
          },
          service: {
            select: {
              id: true,
              name: true,
            },
          },
          check: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
    }

    return this.prisma.alertEvent.create({
      data: {
        ruleId: normalized.record.id,
        fingerprint,
        groupKey: evaluation.groupKey,
        status: nextStatus,
        severity: evaluation.severity,
        message: evaluation.message,
        labels: evaluation.labels as Prisma.InputJsonValue,
        lastValue: evaluation.values as Prisma.InputJsonValue,
        hostId: entityRefs.hostId,
        serviceId: entityRefs.serviceId,
        checkId: entityRefs.checkId,
        lastMatchedAt: now,
      },
      include: {
        rule: {
          select: {
            name: true,
          },
        },
        host: {
          select: {
            id: true,
            hostname: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
        check: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  private async maybeEmitAndNotify(
    normalized: RuleWithSpec,
    draft: AlertRuleDraft,
    current: IncidentRecord,
    previous: IncidentRecord | null,
    silences: ActiveSilence[],
    now: Date,
  ) {
    if (previous?.status !== current.status) {
      const eventType =
        current.status === AlertEventStatus.FIRING
          ? 'alert.firing'
          : current.status === AlertEventStatus.PENDING
            ? 'alert.pending'
            : 'alert.updated';
      await this.eventsService.emit({
        type: eventType,
        message: current.message,
        severity: current.severity,
        hostId: current.hostId ?? undefined,
        serviceId: current.serviceId ?? undefined,
        checkId: current.checkId ?? undefined,
        payload: {
          alertEventId: current.id,
          ruleId: normalized.record.id,
          state: current.status,
        } as Prisma.InputJsonValue,
      });
    }

    if (current.status !== AlertEventStatus.FIRING) {
      return;
    }
    if (current.acknowledgedAt) {
      return;
    }
    if (this.isSilenced(current, silences)) {
      return;
    }

    const repeatMs = draft.spec.delivery.repeatMinutes * 60_000;
    const shouldNotify =
      !previous ||
      previous.status !== AlertEventStatus.FIRING ||
      !previous.lastNotifiedAt ||
      now.getTime() - previous.lastNotifiedAt.getTime() >= repeatMs;

    if (!shouldNotify || draft.spec.delivery.routeIds.length === 0) {
      return;
    }

    await this.notifyRoutes(draft.spec.delivery.routeIds, {
      event: 'alert.firing',
      alertEventId: current.id,
      ruleId: normalized.record.id,
      ruleName: normalized.record.name,
      message: current.message,
      severity: current.severity,
      fingerprint: current.fingerprint,
      status: current.status,
      labels: current.labels ?? {},
      values: current.lastValue ?? {},
    });

    await this.prisma.alertEvent.update({
      where: { id: current.id },
      data: {
        lastNotifiedAt: now,
      },
    });
  }

  private async resolveIncident(
    existing: IncidentRecord,
    draft: AlertRuleDraft,
    now: Date,
    silences: ActiveSilence[],
  ) {
    const resolved = await this.prisma.alertEvent.update({
      where: { id: existing.id },
      data: {
        status: AlertEventStatus.RESOLVED,
        resolvedAt: now,
        lastEvaluatedAt: now,
      },
      include: {
        rule: {
          select: {
            name: true,
          },
        },
        host: {
          select: {
            id: true,
            hostname: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
        check: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await this.eventsService.emit({
      type: 'alert.resolved',
      message: existing.message,
      severity: EventSeverity.INFO,
      hostId: existing.hostId ?? undefined,
      serviceId: existing.serviceId ?? undefined,
      checkId: existing.checkId ?? undefined,
      payload: {
        alertEventId: existing.id,
        ruleId: existing.ruleId,
      } as Prisma.InputJsonValue,
    });

    if (
      draft.spec.delivery.sendResolved &&
      draft.spec.delivery.routeIds.length > 0 &&
      !this.isSilenced(existing, silences) &&
      existing.status === AlertEventStatus.FIRING
    ) {
      await this.notifyRoutes(draft.spec.delivery.routeIds, {
        event: 'alert.resolved',
        alertEventId: resolved.id,
        ruleId: resolved.ruleId,
        ruleName: resolved.rule.name,
        message: resolved.message,
        severity: resolved.severity,
        fingerprint: resolved.fingerprint,
        status: resolved.status,
      });
    }
  }

  /**
   * Handles notify routes.
   */
  private async notifyRoutes(routeIds: string[], payload: Record<string, unknown>) {
    const routes = await this.prisma.notificationRoute.findMany({
      where: {
        enabled: true,
        id: {
          in: routeIds,
        },
      },
    });

    for (const route of routes) {
      try {
        await this.notificationsService.send(route, payload);
      } catch (error) {
        this.logger.warn(`Notification delivery failed for route ${route.id}: ${String(error)}`);
      }
    }
  }

  /**
   * Checks whether silenced.
   */
  private isSilenced(
    incident: Pick<AlertEvent, 'id' | 'ruleId' | 'hostId' | 'serviceId' | 'checkId'>,
    silences: ActiveSilence[],
  ) {
    return silences.some((silence) => {
      if (silence.targetType === 'ALERT_EVENT' && silence.targetId === incident.id) {
        return true;
      }
      if (silence.targetType === 'ALERT_RULE' && silence.targetId === incident.ruleId) {
        return true;
      }
      if (
        silence.targetType === 'HOST' &&
        incident.hostId &&
        silence.targetId === incident.hostId
      ) {
        return true;
      }
      if (
        silence.targetType === 'SERVICE' &&
        incident.serviceId &&
        silence.targetId === incident.serviceId
      ) {
        return true;
      }
      if (
        silence.targetType === 'CHECK' &&
        incident.checkId &&
        silence.targetId === incident.checkId
      ) {
        return true;
      }
      return false;
    });
  }

  private toPreviewIncident(
    evaluation: CandidateEvaluation,
    draft: AlertRuleDraft,
  ): PreviewIncident {
    return {
      fingerprint: evaluation.fingerprint,
      state:
        draft.spec.evaluation.pendingMinutes > 0
          ? AlertEventStatus.PENDING
          : AlertEventStatus.FIRING,
      severity: evaluation.severity,
      message: evaluation.message,
      values: evaluation.values,
      host:
        evaluation.candidate.kind === 'host'
          ? {
              id: evaluation.candidate.hostId,
              name: evaluation.candidate.name,
            }
          : evaluation.candidate.kind === 'check' && evaluation.candidate.host
            ? {
                id: evaluation.candidate.host.id,
                name: evaluation.candidate.host.hostname,
              }
            : null,
      service:
        evaluation.candidate.kind === 'service'
          ? {
              id: evaluation.candidate.serviceId,
              name: evaluation.candidate.name,
            }
          : evaluation.candidate.kind === 'check' && evaluation.candidate.service
            ? {
                id: evaluation.candidate.service.id,
                name: evaluation.candidate.service.name,
              }
            : null,
      check:
        evaluation.candidate.kind === 'check'
          ? {
              id: evaluation.candidate.checkId,
              name: evaluation.candidate.name,
            }
          : null,
    };
  }

  /**
   * Loads parse references for the surrounding workflow.
   */
  private async loadParseReferences(): Promise<ParseReferences> {
    const [hosts, services, checks, routes] = await Promise.all([
      this.prisma.host.findMany({
        orderBy: { hostname: 'asc' },
        take: 200,
        select: {
          id: true,
          hostname: true,
          tags: true,
        },
      }),
      this.prisma.service.findMany({
        orderBy: { name: 'asc' },
        take: 200,
        select: {
          id: true,
          name: true,
        },
      }),
      this.prisma.check.findMany({
        orderBy: { name: 'asc' },
        take: 200,
        select: {
          id: true,
          name: true,
          target: true,
        },
      }),
      this.prisma.notificationRoute.findMany({
        where: { enabled: true },
        orderBy: { name: 'asc' },
        take: 100,
        select: {
          id: true,
          name: true,
          type: true,
        },
      }),
    ]);

    return {
      hosts,
      services,
      checks,
      routes,
      validHostIds: new Set(hosts.map((host) => host.id)),
      validServiceIds: new Set(services.map((service) => service.id)),
      validCheckIds: new Set(checks.map((check) => check.id)),
      validRouteIds: new Set(routes.map((route) => route.id)),
    };
  }

  private buildHeuristicDraft(
    input: AlertParseRequest,
    references: ParseReferences,
  ): DraftWithMetadata {
    const text = input.description.trim();
    const lower = text.toLowerCase();
    const host = findReference(text, references.hosts, (item) => [item.hostname, ...item.tags]);
    const service = findReference(text, references.services, (item) => [item.name]);
    const check = findReference(text, references.checks, (item) => [item.name, item.target]);
    const route = findReference(text, references.routes, (item) => [item.name, item.type]);
    const comparator = inferComparator(lower);
    const threshold = inferNumber(lower);
    const pendingMinutes = inferDurationMinutes(lower);
    const severity = inferSeverity(lower);

    if (lower.includes('offline')) {
      const draft = alertRuleDraftSchema.parse({
        name: `${host?.hostname ?? 'Host'} offline`,
        description: text,
        enabled: false,
        spec: {
          scope: {
            entity: 'host',
            hostIds: host ? [host.id] : input.hostId ? [input.hostId] : undefined,
          },
          conditions: {
            match: 'ALL',
            items: [
              {
                kind: 'state',
                target: 'host_offline',
                staleMinutes: Math.max(pendingMinutes, 1),
              },
            ],
          },
          evaluation: {
            pendingMinutes,
            recoveryMinutes: 5,
            noDataBehavior: 'KEEP_STATE',
          },
          severity,
          labels: {},
          delivery: {
            routeIds: route ? [route.id] : [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      });

      return {
        draft,
        rationale: 'Detected an offline host alert request.',
        confidence: host || input.hostId ? 86 : 74,
      };
    }

    if (
      lower.includes('active alerts') ||
      lower.includes('hosts offline') ||
      lower.includes('hosts online') ||
      lower.includes('failing checks')
    ) {
      const metric = lower.includes('hosts offline')
        ? 'hostsOffline'
        : lower.includes('hosts online')
          ? 'hostsOnline'
          : lower.includes('failing checks')
            ? 'failingChecks'
            : 'activeAlerts';
      const draft = alertRuleDraftSchema.parse({
        name: `${metric} threshold`,
        description: text,
        enabled: false,
        spec: {
          scope: {
            entity: 'homelab',
          },
          conditions: {
            match: 'ALL',
            items: [
              {
                kind: 'homelab_metric',
                metric,
                comparator,
                threshold: threshold ?? 1,
              },
            ],
          },
          evaluation: {
            pendingMinutes,
            recoveryMinutes: 5,
            noDataBehavior: 'KEEP_STATE',
          },
          severity,
          labels: {},
          delivery: {
            routeIds: route ? [route.id] : [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      });

      return {
        draft,
        rationale: 'Detected a homelab-wide threshold alert.',
        confidence: 82,
      };
    }

    if (lower.includes('event')) {
      const draft = alertRuleDraftSchema.parse({
        name: 'Event burst',
        description: text,
        enabled: false,
        spec: {
          scope: {
            entity: 'homelab',
          },
          conditions: {
            match: 'ALL',
            items: [
              {
                kind: 'event_count',
                comparator,
                threshold: threshold ?? 1,
                windowMinutes: Math.max(pendingMinutes || 15, 1),
                severity: severity === 'WARN' ? 'WARN' : severity === 'ERROR' ? 'ERROR' : undefined,
              },
            ],
          },
          evaluation: {
            pendingMinutes: 0,
            recoveryMinutes: 5,
            noDataBehavior: 'RESOLVE',
          },
          severity,
          labels: {},
          delivery: {
            routeIds: route ? [route.id] : [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      });

      return {
        draft,
        rationale: 'Detected an event volume alert request.',
        confidence: 75,
      };
    }

    if (lower.includes('latency') || lower.includes('slow')) {
      const draft = alertRuleDraftSchema.parse({
        name: `${check?.name ?? 'Check'} latency`,
        description: text,
        enabled: false,
        spec: {
          scope: {
            entity: 'check',
            checkIds: check ? [check.id] : input.checkId ? [input.checkId] : undefined,
          },
          conditions: {
            match: 'ALL',
            items: [
              {
                kind: 'check',
                mode: 'latency_gt',
                threshold: threshold ?? 1000,
              },
            ],
          },
          evaluation: {
            pendingMinutes,
            recoveryMinutes: 5,
            noDataBehavior: 'KEEP_STATE',
          },
          severity,
          labels: {},
          delivery: {
            routeIds: route ? [route.id] : [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      });

      return {
        draft,
        rationale: 'Detected a latency-based check alert request.',
        confidence: check || input.checkId ? 84 : 72,
      };
    }

    if (lower.includes('status') && /\b[1-5]\d{2}\b/.test(lower)) {
      const expectedStatus = inferHttpStatus(lower) ?? 200;
      const draft = alertRuleDraftSchema.parse({
        name: `${check?.name ?? 'Check'} unexpected status`,
        description: text,
        enabled: false,
        spec: {
          scope: {
            entity: 'check',
            checkIds: check ? [check.id] : input.checkId ? [input.checkId] : undefined,
          },
          conditions: {
            match: 'ALL',
            items: [
              {
                kind: 'check',
                mode: 'http_status_not',
                expectedStatus,
              },
            ],
          },
          evaluation: {
            pendingMinutes,
            recoveryMinutes: 5,
            noDataBehavior: 'KEEP_STATE',
          },
          severity,
          labels: {},
          delivery: {
            routeIds: route ? [route.id] : [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      });

      return {
        draft,
        rationale: 'Detected an HTTP status alert request.',
        confidence: 78,
      };
    }

    if (lower.includes('check') || lower.includes('down') || lower.includes('fail')) {
      const thresholdRuns = inferFailureThreshold(lower);
      const draft = alertRuleDraftSchema.parse({
        name: `${check?.name ?? 'Check'} failures`,
        description: text,
        enabled: false,
        spec: {
          scope: {
            entity: 'check',
            checkIds: check ? [check.id] : input.checkId ? [input.checkId] : undefined,
          },
          conditions: {
            match: 'ALL',
            items: [
              {
                kind: 'check',
                mode: lower.includes(' of ') ? 'failures_in_window' : 'consecutive_failures',
                threshold: thresholdRuns.threshold,
                sampleSize: thresholdRuns.sampleSize,
                status: 'DOWN',
              },
            ],
          },
          evaluation: {
            pendingMinutes: 0,
            recoveryMinutes: 5,
            noDataBehavior: 'KEEP_STATE',
          },
          severity,
          labels: {},
          delivery: {
            routeIds: route ? [route.id] : [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      });

      return {
        draft,
        rationale: 'Detected a check failure alert request.',
        confidence: check || input.checkId ? 85 : 73,
      };
    }

    const metric =
      lower.includes('memory') || lower.includes('mem')
        ? 'memPct'
        : lower.includes('disk io') || lower.includes('iops')
          ? 'diskIoOps'
          : lower.includes('network')
            ? 'networkKbps'
            : lower.includes('disk')
              ? 'diskPct'
              : 'cpuPct';
    const draft = alertRuleDraftSchema.parse({
      name: `${host?.hostname ?? 'Host'} ${metric}`,
      description: text,
      enabled: false,
      spec: {
        scope: {
          entity: 'host',
          hostIds: host ? [host.id] : input.hostId ? [input.hostId] : undefined,
        },
        conditions: {
          match: 'ALL',
          items: [
            {
              kind: 'host_metric',
              metric,
              comparator,
              threshold:
                threshold ?? (metric === 'networkKbps' || metric === 'diskIoOps' ? 1000 : 85),
              reducer: 'latest',
              windowMinutes: pendingMinutes || 5,
            },
          ],
        },
        evaluation: {
          pendingMinutes,
          recoveryMinutes: 5,
          noDataBehavior: 'KEEP_STATE',
        },
        severity,
        labels: {},
        delivery: {
          routeIds: route ? [route.id] : [],
          repeatMinutes: 60,
          sendResolved: true,
        },
      },
    });

    return {
      draft,
      rationale: 'Parsed a host metric threshold alert request.',
      confidence: host || input.hostId ? 84 : 70,
    };
  }

  /**
   * Handles sanitize draft.
   */
  private sanitizeDraft(
    draft: AlertRuleDraft,
    references: ParseReferences,
    fallback: AlertRuleDraft,
  ) {
    const parsed = alertRuleDraftSchema.safeParse(draft);
    if (!parsed.success) {
      return fallback;
    }

    const next = parsed.data;
    return {
      ...next,
      enabled: false,
      spec: {
        ...next.spec,
        scope: {
          ...next.spec.scope,
          hostIds: next.spec.scope.hostIds?.filter((id) => references.validHostIds.has(id)),
          serviceIds: next.spec.scope.serviceIds?.filter((id) =>
            references.validServiceIds.has(id),
          ),
          checkIds: next.spec.scope.checkIds?.filter((id) => references.validCheckIds.has(id)),
        },
        delivery: {
          ...next.spec.delivery,
          routeIds: next.spec.delivery.routeIds.filter((id) => references.validRouteIds.has(id)),
        },
      },
    };
  }
}

/**
 * Implements normalize rule spec.
 */
function normalizeRuleSpec(rule: RuleRecord, logger: Logger): AlertRuleSpec {
  if (rule.type === AlertRuleType.CHECK_DOWN_CONSECUTIVE) {
    const config = toRecord(rule.config);
    const consecutive = Math.max(readNumber(config?.consecutive) ?? 3, 1);
    return alertRuleSpecSchema.parse({
      scope: {
        entity: 'check',
        checkIds: readString(config?.checkId) ? [String(config?.checkId)] : undefined,
      },
      conditions: {
        match: 'ALL',
        items: [
          {
            kind: 'check',
            mode: 'consecutive_failures',
            threshold: consecutive,
            status: 'DOWN',
          },
        ],
      },
      evaluation: {
        pendingMinutes: 0,
        recoveryMinutes: 5,
        noDataBehavior: 'KEEP_STATE',
      },
      severity: 'ERROR',
      labels: {},
      delivery: {
        routeIds: [],
        repeatMinutes: 60,
        sendResolved: true,
      },
    });
  }

  if (rule.type === AlertRuleType.HOST_OFFLINE) {
    const config = toRecord(rule.config);
    const seconds = Math.max(readNumber(config?.seconds) ?? 120, 60);
    return alertRuleSpecSchema.parse({
      scope: {
        entity: 'host',
        hostIds: readString(config?.hostId) ? [String(config?.hostId)] : undefined,
      },
      conditions: {
        match: 'ALL',
        items: [
          {
            kind: 'state',
            target: 'host_offline',
            staleMinutes: Math.max(Math.round(seconds / 60), 1),
          },
        ],
      },
      evaluation: {
        pendingMinutes: 0,
        recoveryMinutes: 5,
        noDataBehavior: 'KEEP_STATE',
      },
      severity: 'ERROR',
      labels: {},
      delivery: {
        routeIds: [],
        repeatMinutes: 60,
        sendResolved: true,
      },
    });
  }

  if (rule.type === AlertRuleType.DISK_USAGE_GT) {
    const config = toRecord(rule.config);
    return alertRuleSpecSchema.parse({
      scope: {
        entity: 'host',
        hostIds: readString(config?.hostId) ? [String(config?.hostId)] : undefined,
      },
      conditions: {
        match: 'ALL',
        items: [
          {
            kind: 'host_metric',
            metric: 'diskPct',
            comparator: 'GT',
            threshold: readNumber(config?.threshold) ?? 85,
            reducer: 'latest',
          },
        ],
      },
      evaluation: {
        pendingMinutes: 0,
        recoveryMinutes: 5,
        noDataBehavior: 'KEEP_STATE',
      },
      severity: 'ERROR',
      labels: {},
      delivery: {
        routeIds: [],
        repeatMinutes: 60,
        sendResolved: true,
      },
    });
  }

  const parsed = alertRuleSpecSchema.safeParse(rule.config);
  if (parsed.success) {
    return parsed.data;
  }

  logger.warn(`Invalid alert rule config for ${rule.id}; falling back to default rule draft`);
  return defaultRuleDraft.spec;
}

/**
 * Implements to incident summary.
 */
function toIncidentSummary(incident: IncidentRecord): AlertIncident {
  return {
    id: incident.id,
    ruleId: incident.ruleId,
    ruleName: incident.rule.name,
    fingerprint: incident.fingerprint,
    state: incident.status,
    severity: incident.severity,
    message: incident.message,
    startedAt: incident.startedAt.toISOString(),
    lastMatchedAt: incident.lastMatchedAt ? incident.lastMatchedAt.toISOString() : null,
    lastEvaluatedAt: incident.lastEvaluatedAt.toISOString(),
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    acknowledgedAt: incident.acknowledgedAt ? incident.acknowledgedAt.toISOString() : null,
    labels: toStringRecord(incident.labels),
    values: toUnknownRecord(incident.lastValue),
    host: incident.host
      ? {
          id: incident.host.id,
          name: incident.host.hostname,
        }
      : null,
    service: incident.service
      ? {
          id: incident.service.id,
          name: incident.service.name,
        }
      : null,
    check: incident.check
      ? {
          id: incident.check.id,
          name: incident.check.name,
        }
      : null,
  };
}

/**
 * Checks whether candidate refs.
 */
function candidateRefs(candidate: CandidateEntity) {
  if (candidate.kind === 'host') {
    return {
      hostId: candidate.hostId,
      serviceId: undefined,
      checkId: undefined,
    };
  }
  if (candidate.kind === 'service') {
    return {
      hostId: undefined,
      serviceId: candidate.serviceId,
      checkId: undefined,
    };
  }
  if (candidate.kind === 'check') {
    return {
      hostId: candidate.hostId,
      serviceId: candidate.serviceId,
      checkId: candidate.checkId,
    };
  }
  return {
    hostId: undefined,
    serviceId: undefined,
    checkId: undefined,
  };
}

/**
 * Checks whether keep open for recovery.
 */
function shouldKeepOpenForRecovery(
  existing: Pick<AlertEvent, 'lastMatchedAt'>,
  spec: AlertRuleSpec,
  now: Date,
) {
  const recoveryMs = spec.evaluation.recoveryMinutes * 60_000;
  if (!existing.lastMatchedAt || recoveryMs <= 0) {
    return false;
  }
  return now.getTime() - existing.lastMatchedAt.getTime() < recoveryMs;
}

/**
 * Builds fingerprint.
 */
function buildFingerprint(ruleKey: string, entityType: string, entityId: string) {
  return `${ruleKey}:${entityType}:${entityId}`;
}

/**
 * Implements compare numbers.
 */
function compareNumbers(actual: number, comparator: AlertComparator, threshold: number) {
  if (comparator === 'GT') {
    return actual > threshold;
  }
  if (comparator === 'GTE') {
    return actual >= threshold;
  }
  if (comparator === 'LT') {
    return actual < threshold;
  }
  if (comparator === 'LTE') {
    return actual <= threshold;
  }
  if (comparator === 'EQ') {
    return actual === threshold;
  }
  return actual !== threshold;
}

/**
 * Implements format comparator.
 */
function formatComparator(comparator: AlertComparator) {
  if (comparator === 'GT') {
    return '>';
  }
  if (comparator === 'GTE') {
    return '>=';
  }
  if (comparator === 'LT') {
    return '<';
  }
  if (comparator === 'LTE') {
    return '<=';
  }
  if (comparator === 'EQ') {
    return '=';
  }
  return '!=';
}

/**
 * Implements format metric value.
 */
function formatMetricValue(metric: string, value: number) {
  if (metric === 'cpuPct' || metric === 'memPct' || metric === 'diskPct') {
    return `${value.toFixed(1)}%`;
  }
  return value.toFixed(1);
}

/**
 * Implements severity order.
 */
function severityOrder(severity: EventSeverity) {
  if (severity === EventSeverity.ERROR) {
    return 3;
  }
  if (severity === EventSeverity.WARN) {
    return 2;
  }
  return 1;
}

/**
 * Implements read host fact metric.
 */
function readHostFactMetric(snapshot: unknown, metric: string) {
  const record = toRecord(snapshot);
  if (!record) {
    return null;
  }
  if (metric === 'cpuPct') {
    return pickNumber(record, [
      ['cpu', 'usagePct'],
      ['cpu', 'pct'],
      ['cpu', 'totalPct'],
      ['cpuPct'],
    ]);
  }
  if (metric === 'memPct') {
    return pickNumber(record, [
      ['memory', 'usedPct'],
      ['memory', 'pct'],
      ['memoryPct'],
      ['memPct'],
    ]);
  }
  if (metric === 'diskPct') {
    return pickNumber(record, [['storage', 'usedPct'], ['storage', 'pct'], ['diskPct']]);
  }
  if (metric === 'networkKbps') {
    return pickNumber(record, [
      ['network', 'throughputKbps'],
      ['network', 'kbps'],
      ['network', 'totalKbps'],
    ]);
  }
  return pickNumber(record, [['storage', 'io', 'iops'], ['storage', 'iops'], ['diskIoOps']]);
}

/**
 * Implements pick number.
 */
function pickNumber(record: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    let cursor: unknown = record;
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        cursor = null;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === 'number' && Number.isFinite(cursor)) {
      return cursor;
    }
  }
  return null;
}

/**
 * Implements to record.
 */
function toRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Implements to string record.
 */
function toStringRecord(value: unknown): Record<string, string> {
  const record = toRecord(value);
  if (!record) {
    return {};
  }
  const pairs = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(pairs);
}

/**
 * Implements to unknown record.
 */
function toUnknownRecord(value: unknown): Record<string, unknown> {
  return toRecord(value) ?? {};
}

/**
 * Implements infer comparator.
 */
function inferComparator(lower: string): AlertComparator {
  if (lower.includes('at least') || lower.includes('>=') || lower.includes('or more')) {
    return 'GTE';
  }
  if (lower.includes('below') || lower.includes('under') || lower.includes('<')) {
    return 'LT';
  }
  if (lower.includes('at most') || lower.includes('<=') || lower.includes('or less')) {
    return 'LTE';
  }
  if (lower.includes('equals') || lower.includes('equal to')) {
    return 'EQ';
  }
  if (lower.includes('not ') || lower.includes('!=')) {
    return 'NEQ';
  }
  return 'GT';
}

/**
 * Implements infer number.
 */
function inferNumber(lower: string) {
  const match = lower.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/**
 * Implements infer duration minutes.
 */
function inferDurationMinutes(lower: string) {
  const match = lower.match(/(\d+)\s*(minute|minutes|min|mins|m)\b/);
  if (match) {
    return Math.max(Number(match[1]), 0);
  }
  const seconds = lower.match(/(\d+)\s*(second|seconds|sec|secs|s)\b/);
  if (seconds) {
    return Math.max(Math.round(Number(seconds[1]) / 60), 0);
  }
  return 0;
}

/**
 * Implements infer severity.
 */
function inferSeverity(lower: string): EventSeverity {
  if (lower.includes('warn')) {
    return EventSeverity.WARN;
  }
  if (lower.includes('info')) {
    return EventSeverity.INFO;
  }
  return EventSeverity.ERROR;
}

/**
 * Implements infer http status.
 */
function inferHttpStatus(lower: string) {
  const match = lower.match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Implements infer failure threshold.
 */
function inferFailureThreshold(lower: string) {
  const ofMatch = lower.match(/(\d+)\s+of\s+(\d+)/);
  if (ofMatch) {
    return {
      threshold: Math.max(Number(ofMatch[1]), 1),
      sampleSize: Math.max(Number(ofMatch[2]), Number(ofMatch[1]), 1),
    };
  }
  const threshold = inferNumber(lower) ?? 3;
  return {
    threshold: Math.max(threshold, 1),
    sampleSize: undefined,
  };
}

/**
 * Parses ai alert draft.
 */
function parseAiAlertDraft(text: string): DraftWithMetadata | null {
  const parsed = aiAlertDraftEnvelopeSchema.safeParse(JSON.parse(text || '{}'));
  if (!parsed.success) {
    return null;
  }

  if ('draft' in parsed.data) {
    return {
      draft: parsed.data.draft,
      rationale: parsed.data.rationale ?? null,
      confidence: parsed.data.confidence ?? null,
    };
  }

  return {
    draft: parsed.data,
    rationale: null,
    confidence: null,
  };
}

function findReference<T extends { id: string }>(
  text: string,
  items: T[],
  terms: (item: T) => string[],
) {
  const lower = text.toLowerCase();
  return items.find((item) =>
    terms(item).some((term) => {
      const normalized = term.trim().toLowerCase();
      return normalized.length > 0 && lower.includes(normalized);
    }),
  );
}

/**
 * Implements read number.
 */
function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Implements read string.
 */
function readString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

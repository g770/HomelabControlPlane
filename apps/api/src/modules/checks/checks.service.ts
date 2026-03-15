/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements checks service business logic for the service layer.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Check, Prisma } from '@prisma/client';
import { createCheckSchema } from '@homelab/shared';
import * as net from 'net';
import ping from 'ping';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AI_PERSONALITY_MEMORY_KEY,
  DEFAULT_AI_PERSONALITY,
  buildPersonalitySystemPrompt,
  readAiPersonalityFromJson,
} from '../ai/ai-personality';

// Runtime check result shape used before writing to check_results.
type CheckRunResult = {
  status: CheckResultStatus;
  latencyMs?: number;
  httpStatus?: number;
  errorMessage?: string;
  details?: Prisma.InputJsonValue;
};

type MonitorType = 'HTTP' | 'TCP' | 'ICMP';

type MonitorDraft = {
  name: string;
  type: MonitorType;
  target: string;
  expectedStatus?: number;
  intervalSec: number;
  timeoutMs: number;
  keyword?: string;
  enabled: boolean;
  hostId?: string;
  serviceId?: string;
  rationale?: string;
  confidence?: number;
};

type MonitorParseInput = {
  description: string;
  hostId?: string;
  serviceId?: string;
};

type MonitorSuggestionResponse = {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  expectedStatus?: number;
  intervalSec: number;
  timeoutMs: number;
  keyword?: string;
  enabled: boolean;
  hostId?: string;
  serviceId?: string;
  rationale?: string;
  confidence?: number;
};

const aiMonitorDraftSchema = z
  .object({
    name: z.string().min(1).max(120),
    type: z.enum(['HTTP', 'TCP', 'ICMP']),
    target: z.string().min(1).max(500),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    intervalSec: z.number().int().min(10).max(3600),
    timeoutMs: z.number().int().min(100).max(30000),
    keyword: z.string().min(1).max(240).optional(),
    enabled: z.boolean().default(true),
    hostId: z.string().uuid().optional(),
    serviceId: z.string().uuid().optional(),
    rationale: z.string().min(1).max(500).optional(),
    confidence: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const aiMonitorParseEnvelopeSchema = z.union([
  aiMonitorDraftSchema,
  z
    .object({
      monitor: aiMonitorDraftSchema,
    })
    .strict(),
]);

const aiMonitorSuggestionsSchema = z
  .object({
    suggestions: z.array(aiMonitorDraftSchema).min(1).max(40),
  })
  .strict();

const placeholderKeywordTokens = new Set(['optional', 'none', 'n/a', 'na', 'null']);
const alertEventStatusesOpen = ['PENDING', 'FIRING'];
const eventSeverityError = 'ERROR';

type CheckResultStatus = 'UP' | 'DOWN' | 'UNKNOWN';
const checkResultStatuses = {
  UP: 'UP' as CheckResultStatus,
  DOWN: 'DOWN' as CheckResultStatus,
  UNKNOWN: 'UNKNOWN' as CheckResultStatus,
};

type CheckType = 'HTTP' | 'TCP' | 'ICMP';
const checkTypes = {
  HTTP: 'HTTP' as CheckType,
  TCP: 'TCP' as CheckType,
  ICMP: 'ICMP' as CheckType,
};

// Monitor lifecycle service: CRUD, execution, history, and AI-assisted authoring.
@Injectable()
/**
 * Implements the checks service class.
 */
export class ChecksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: EventsService,
    private readonly auditService: AuditService,
    private readonly aiProviderService: AiProviderService,
  ) {}

  // Returns monitors with latest result for monitor list screens.
  list() {
    return this.prisma.check.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        host: true,
        service: true,
        results: {
          orderBy: { checkedAt: 'desc' },
          take: 1,
        },
      },
    });
  }

  // Loads monitor detail + result history and fails fast for unknown IDs.
  async get(id: string) {
    const check = await this.prisma.check.findUnique({
      where: { id },
      include: {
        host: true,
        service: true,
        results: {
          orderBy: { checkedAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!check) {
      throw new NotFoundException('Check not found');
    }

    return check;
  }

  // Creates a monitor from validated input and emits an audit/event record.
  async create(userId: string, input: unknown) {
    const payload = createCheckSchema.parse(input);

    const created = await this.prisma.check.create({
      data: {
        name: payload.name,
        type: payload.type,
        target: payload.target,
        expectedStatus: payload.expectedStatus,
        intervalSec: payload.intervalSec,
        timeoutMs: payload.timeoutMs,
        keyword: payload.keyword,
        enabled: payload.enabled,
        hostId: payload.hostId,
        serviceId: payload.serviceId,
      },
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'check.create',
      targetType: 'check',
      targetId: created.id,
      paramsJson: payload,
      success: true,
    });

    await this.eventsService.emit({
      type: 'check.created',
      message: `Check created: ${created.name}`,
      checkId: created.id,
      hostId: created.hostId ?? undefined,
    });

    return created;
  }

  // Parses plain-English monitor requests via AI with deterministic fallback.
  async parseMonitorDescription(userId: string, input: MonitorParseInput) {
    const description = input.description.trim();
    if (!description) {
      throw new BadRequestException('Description is required');
    }

    const references = await this.loadMonitorReferences();
    const fallback = this.buildHeuristicDraft(description, {
      hostId: input.hostId,
      serviceId: input.serviceId,
    });
    const fallbackSanitized = this.sanitizeMonitorDraft(
      fallback,
      references.validHostIds,
      references.validServiceIds,
    );

    const openai = await this.aiProviderService.getClient();
    if (!openai) {
      return {
        aiEnabled: false,
        generatedByAi: false,
        warnings: ['AI is disabled. Parsed using heuristics.'],
        monitor: toCreatePayload(fallbackSanitized),
        rationale: fallbackSanitized.rationale ?? null,
        confidence: fallbackSanitized.confidence ?? null,
      };
    }

    const personality = await this.resolveUserPersonality(userId);

    try {
      const response = await openai.responses.create({
        model: this.aiProviderService.getModel(),
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: buildPersonalitySystemPrompt(
                  [
                    'You translate plain-English monitor requests into strict check configuration JSON.',
                    'Return JSON only and no markdown.',
                    'Use exactly one monitor object matching this shape:',
                    JSON.stringify({
                      name: 'string',
                      type: 'HTTP | TCP | ICMP',
                      target: 'string',
                      intervalSec: 60,
                      timeoutMs: 2000,
                      enabled: true,
                      expectedStatus: 200,
                    }),
                    'For HTTP, include expectedStatus and include keyword only when a specific body string must be matched.',
                    'Omit optional fields when unknown: keyword, hostId, serviceId, rationale, confidence.',
                    'For TCP, target must be host:port.',
                    'For ICMP, target must be hostname or IP.',
                    'Respect bounds: intervalSec 10..3600, timeoutMs 100..30000.',
                    'Use only hostId/serviceId values provided in the context when applicable.',
                  ].join(' '),
                  personality,
                ),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  description,
                  selectedHostId: input.hostId ?? null,
                  selectedServiceId: input.serviceId ?? null,
                  knownHosts: references.hosts.slice(0, 80),
                  knownServices: references.services.slice(0, 80),
                  fallbackSuggestion: fallbackSanitized,
                }),
              },
            ],
          },
        ],
      });

      const parsed = parseAiMonitorDraft(response.output_text ?? '');
      if (!parsed) {
        return {
          aiEnabled: true,
          generatedByAi: false,
          warnings: ['AI response could not be parsed. Parsed using heuristics.'],
          monitor: toCreatePayload(fallbackSanitized),
          rationale: fallbackSanitized.rationale ?? null,
          confidence: fallbackSanitized.confidence ?? null,
        };
      }

      const sanitized = this.sanitizeMonitorDraft(
        parsed,
        references.validHostIds,
        references.validServiceIds,
        fallbackSanitized,
      );
      return {
        aiEnabled: true,
        generatedByAi: true,
        warnings: [],
        monitor: toCreatePayload(sanitized),
        rationale: sanitized.rationale ?? null,
        confidence: sanitized.confidence ?? null,
      };
    } catch {
      return {
        aiEnabled: true,
        generatedByAi: false,
        warnings: ['AI parse failed. Parsed using heuristics.'],
        monitor: toCreatePayload(fallbackSanitized),
        rationale: fallbackSanitized.rationale ?? null,
        confidence: fallbackSanitized.confidence ?? null,
      };
    }
  }

  // Produces monitor recommendations from infrastructure context + AI analysis.
  async suggestMonitors(userId: string) {
    const [hosts, services, existingChecks, activeAlerts, recentEvents] = await Promise.all([
      this.prisma.host.findMany({
        orderBy: { hostname: 'asc' },
        take: 240,
        select: {
          id: true,
          hostname: true,
          status: true,
          lastSeenAt: true,
          tags: true,
        },
      }),
      this.prisma.service.findMany({
        orderBy: { name: 'asc' },
        take: 240,
        select: {
          id: true,
          name: true,
          tags: true,
          source: true,
          status: true,
          instances: {
            take: 12,
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              endpoint: true,
              hostId: true,
              host: {
                select: {
                  hostname: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.check.findMany({
        orderBy: { createdAt: 'desc' },
        take: 400,
        select: {
          id: true,
          name: true,
          type: true,
          target: true,
          enabled: true,
          hostId: true,
          serviceId: true,
        },
      }),
      this.prisma.alertEvent.findMany({
        where: { status: { in: alertEventStatusesOpen } },
        orderBy: { startedAt: 'desc' },
        take: 30,
        select: {
          id: true,
          message: true,
          startedAt: true,
          checkId: true,
          hostId: true,
          rule: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
        },
      }),
      this.prisma.event.findMany({
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: {
          id: true,
          type: true,
          message: true,
          severity: true,
          createdAt: true,
        },
      }),
    ]);

    const references = {
      validHostIds: new Set(hosts.map((host) => host.id)),
      validServiceIds: new Set(services.map((service) => service.id)),
    };
    const existingKeys = new Set(
      existingChecks.map((check) => buildMonitorKey(check.type as MonitorType, check.target)),
    );
    const heuristic = this.buildHeuristicSuggestions(hosts, services, existingKeys);
    let suggestions = heuristic;
    let generatedByAi = false;
    const warnings: string[] = [];

    const openai = await this.aiProviderService.getClient();
    const aiEnabled = Boolean(openai);

    if (!openai) {
      warnings.push('AI is disabled. Generated heuristic suggestions only.');
    } else {
      const personality = await this.resolveUserPersonality(userId);
      try {
        const response = await openai.responses.create({
          model: this.aiProviderService.getModel(),
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: buildPersonalitySystemPrompt(
                    [
                      'You recommend monitor checks for a homelab.',
                      'Return JSON only using this exact shape:',
                      JSON.stringify({
                        suggestions: [
                          {
                            name: 'string',
                            type: 'HTTP | TCP | ICMP',
                            target: 'string',
                            intervalSec: 60,
                            timeoutMs: 2000,
                            enabled: true,
                            expectedStatus: 200,
                          },
                        ],
                      }),
                      'Omit optional fields when unknown: keyword, hostId, serviceId, rationale, confidence.',
                      'Avoid duplicates of existing checks.',
                      'Use hostId/serviceId only when those IDs are present in input context.',
                      'Prioritize high-value checks with broad coverage and clear operational signal.',
                      'Keep to at most 25 suggestions.',
                    ].join(' '),
                    personality,
                  ),
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: JSON.stringify({
                    hosts,
                    services,
                    existingChecks,
                    activeAlerts,
                    recentEvents,
                    baselineSuggestions: heuristic.slice(0, 20),
                  }),
                },
              ],
            },
          ],
        });

        const parsed = parseAiMonitorSuggestions(response.output_text ?? '');
        if (parsed.length === 0) {
          warnings.push('AI suggestions could not be parsed. Showing heuristic suggestions.');
        } else {
          const normalized = parsed
            .map((entry) =>
              this.sanitizeMonitorDraft(entry, references.validHostIds, references.validServiceIds),
            )
            .filter((entry) => !existingKeys.has(buildMonitorKey(entry.type, entry.target)));

          const deduped: MonitorDraft[] = [];
          const seen = new Set(existingKeys);
          for (const suggestion of normalized) {
            const key = buildMonitorKey(suggestion.type, suggestion.target);
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            deduped.push(suggestion);
            if (deduped.length >= 25) {
              break;
            }
          }

          if (deduped.length > 0) {
            suggestions = deduped;
            generatedByAi = true;
          } else {
            warnings.push(
              'AI returned only duplicates of existing monitors. Showing heuristic suggestions.',
            );
          }
        }
      } catch {
        warnings.push('AI suggestions failed. Showing heuristic suggestions.');
      }
    }

    const resultSuggestions: MonitorSuggestionResponse[] = suggestions
      .slice(0, 30)
      .map((suggestion, index) => ({
        id: `suggested-monitor-${index + 1}`,
        ...toCreatePayload(suggestion),
        rationale: suggestion.rationale,
        confidence: suggestion.confidence,
      }));

    return {
      generatedAt: new Date().toISOString(),
      aiEnabled,
      generatedByAi,
      warnings,
      suggestions: resultSuggestions,
    };
  }

  /**
   * Handles resolve user personality.
   */
  private async resolveUserPersonality(userId: string) {
    const setting = await this.prisma.opsMemory.findUnique({
      where: {
        userId_key: {
          userId,
          key: AI_PERSONALITY_MEMORY_KEY,
        },
      },
      select: {
        value: true,
      },
    });

    return readAiPersonalityFromJson(setting?.value) ?? DEFAULT_AI_PERSONALITY;
  }

  // Partial update for monitor form edits.
  async update(id: string, userId: string, input: unknown) {
    const parsed = createCheckSchema.partial().safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const updated = await this.prisma.check.update({
      where: { id },
      data: parsed.data,
    });

    await this.auditService.write({
      actorUserId: userId,
      action: 'check.update',
      targetType: 'check',
      targetId: id,
      paramsJson: parsed.data as Prisma.InputJsonValue,
      success: true,
    });

    return updated;
  }

  // Deletes a monitor and records the operation in audit events.
  async remove(id: string, userId: string) {
    await this.prisma.check.delete({ where: { id } });

    await this.auditService.write({
      actorUserId: userId,
      action: 'check.delete',
      targetType: 'check',
      targetId: id,
      success: true,
    });

    return { ok: true };
  }

  // Returns bounded historical check results for charting.
  async history(id: string, hours = 24) {
    const since = new Date(Date.now() - Math.max(hours, 1) * 60 * 60 * 1000);
    return this.prisma.checkResult.findMany({
      where: {
        checkId: id,
        checkedAt: { gte: since },
      },
      orderBy: { checkedAt: 'asc' },
    });
  }

  // Executes a single monitor and emits failure events on DOWN status.
  async runCheck(check: Check) {
    const result = await this.executeCheck(check);

    const checkResult = await this.prisma.checkResult.create({
      data: {
        checkId: check.id,
        status: result.status,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        errorMessage: result.errorMessage,
        details: result.details as Prisma.InputJsonValue | undefined,
      },
    });

    if (result.status === checkResultStatuses.DOWN) {
      await this.eventsService.emit({
        type: 'check.down',
        message: `Check failed: ${check.name}`,
        severity: eventSeverityError,
        checkId: check.id,
        hostId: check.hostId ?? undefined,
        payload: {
          target: check.target,
          error: result.errorMessage,
        },
      });
    }

    return checkResult;
  }

  // Worker-style sequential runner for all enabled monitors.
  async runAllEnabled() {
    const checks = await this.prisma.check.findMany({ where: { enabled: true } });
    const results = [];

    for (const check of checks) {
      const result = await this.runCheck(check);
      results.push(result);
    }

    return results;
  }

  // Dispatches to transport-specific probe logic.
  private async executeCheck(check: Check): Promise<CheckRunResult> {
    switch (check.type) {
      case checkTypes.HTTP:
        return this.runHttpCheck(check);
      case checkTypes.TCP:
        return this.runTcpCheck(check);
      case checkTypes.ICMP:
        return this.runIcmpCheck(check);
      default:
        return {
          status: checkResultStatuses.UNKNOWN,
          errorMessage: 'Unsupported check type',
        };
    }
  }

  // HTTP probe with timeout + status/body keyword validation.
  private async runHttpCheck(check: Check): Promise<CheckRunResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), check.timeoutMs);

    try {
      const response = await fetch(check.target, { signal: controller.signal });
      const bodyText = await response.text();
      const elapsed = Date.now() - started;
      const statusMatches = check.expectedStatus
        ? response.status === check.expectedStatus
        : response.ok;
      const keywordMatches = check.keyword ? bodyText.includes(check.keyword) : true;

      return {
        status: statusMatches && keywordMatches ? checkResultStatuses.UP : checkResultStatuses.DOWN,
        latencyMs: elapsed,
        httpStatus: response.status,
        errorMessage:
          statusMatches && keywordMatches
            ? undefined
            : `Expectation mismatch status=${response.status}`,
      };
    } catch (error) {
      return {
        status: checkResultStatuses.DOWN,
        latencyMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : 'HTTP check failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Raw TCP connectivity probe for host:port targets.
  private runTcpCheck(check: Check): Promise<CheckRunResult> {
    return new Promise((resolve) => {
      const [host, portText] = check.target.split(':');
      const port = Number(portText);
      if (!host || Number.isNaN(port)) {
        resolve({ status: checkResultStatuses.DOWN, errorMessage: 'Invalid TCP target' });
        return;
      }

      const socket = new net.Socket();
      const started = Date.now();

      /**
       * Implements cleanup.
       */
      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.setTimeout(check.timeoutMs);

      socket.on('connect', () => {
        const latencyMs = Date.now() - started;
        cleanup();
        resolve({ status: checkResultStatuses.UP, latencyMs });
      });

      socket.on('timeout', () => {
        cleanup();
        resolve({ status: checkResultStatuses.DOWN, errorMessage: 'TCP timeout' });
      });

      socket.on('error', (error) => {
        cleanup();
        resolve({ status: checkResultStatuses.DOWN, errorMessage: error.message });
      });

      socket.connect(port, host);
    });
  }

  // ICMP reachability probe.
  private async runIcmpCheck(check: Check): Promise<CheckRunResult> {
    const started = Date.now();

    try {
      const response = await ping.promise.probe(check.target, {
        timeout: Math.ceil(check.timeoutMs / 1000),
      });

      return {
        status: response.alive ? checkResultStatuses.UP : checkResultStatuses.DOWN,
        latencyMs: Date.now() - started,
        details: {
          output: response.output,
          min: response.min,
          max: response.max,
          avg: response.avg,
        },
      };
    } catch (error) {
      return {
        status: checkResultStatuses.DOWN,
        latencyMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : 'ICMP check failed',
      };
    }
  }

  // Loads host/service references used to validate AI-generated IDs.
  private async loadMonitorReferences() {
    const [hosts, services] = await Promise.all([
      this.prisma.host.findMany({
        orderBy: { hostname: 'asc' },
        take: 240,
        select: {
          id: true,
          hostname: true,
          status: true,
          lastSeenAt: true,
        },
      }),
      this.prisma.service.findMany({
        orderBy: { name: 'asc' },
        take: 240,
        select: {
          id: true,
          name: true,
          status: true,
          source: true,
        },
      }),
    ]);

    return {
      hosts,
      services,
      validHostIds: new Set(hosts.map((host) => host.id)),
      validServiceIds: new Set(services.map((service) => service.id)),
    };
  }

  // Builds deterministic baseline suggestions when AI is unavailable or fails.
  private buildHeuristicSuggestions(
    hosts: Array<{
      id: string;
      hostname: string;
    }>,
    services: Array<{
      id: string;
      name: string;
      instances: Array<{
        endpoint: string | null;
        hostId: string | null;
        host: {
          hostname: string;
        } | null;
      }>;
    }>,
    existingKeys: Set<string>,
  ) {
    const suggestions: MonitorDraft[] = [];
    const seen = new Set(existingKeys);

    for (const host of hosts) {
      const target = host.hostname.trim();
      if (!target) {
        continue;
      }
      const key = buildMonitorKey('ICMP', target);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      suggestions.push({
        name: `Ping ${target}`,
        type: 'ICMP',
        target,
        intervalSec: 60,
        timeoutMs: 2000,
        enabled: true,
        hostId: host.id,
        rationale: 'Baseline reachability monitor for the host.',
        confidence: 72,
      });
      if (suggestions.length >= 20) {
        break;
      }
    }

    for (const service of services) {
      for (const instance of service.instances) {
        if (!instance.endpoint) {
          continue;
        }
        const httpTarget = normalizeHttpTarget(instance.endpoint);
        if (!httpTarget) {
          continue;
        }
        const key = buildMonitorKey('HTTP', httpTarget);
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        suggestions.push({
          name: `${service.name} endpoint`,
          type: 'HTTP',
          target: httpTarget,
          expectedStatus: 200,
          intervalSec: 60,
          timeoutMs: 2500,
          enabled: true,
          hostId: instance.hostId ?? undefined,
          serviceId: service.id,
          rationale: 'Discovered service endpoint should be monitored for availability.',
          confidence: 78,
        });

        if (suggestions.length >= 30) {
          return suggestions;
        }
      }
    }

    return suggestions;
  }

  // Lightweight text parser fallback for plain-English monitor descriptions.
  private buildHeuristicDraft(
    description: string,
    preference: {
      hostId?: string;
      serviceId?: string;
    },
  ): MonitorDraft {
    const lower = description.toLowerCase();
    const intervalSec = parseIntervalSeconds(description) ?? 60;
    const timeoutMs = parseTimeoutMillis(description) ?? 2000;
    const keyword = parseKeyword(description);
    const expectedStatus = parseExpectedStatus(description) ?? 200;
    const detectedType = detectMonitorType(description);

    if (detectedType === 'ICMP') {
      const target = parseHostTarget(description) ?? '127.0.0.1';
      return {
        name: `Ping ${target}`,
        type: 'ICMP',
        target,
        intervalSec,
        timeoutMs,
        enabled: true,
        hostId: preference.hostId,
        serviceId: preference.serviceId,
        rationale: 'Heuristic parse from plain-English monitor request.',
        confidence: 45,
      };
    }

    if (detectedType === 'TCP') {
      const target = parseTcpTarget(description) ?? 'localhost:443';
      return {
        name: `TCP ${target}`,
        type: 'TCP',
        target,
        intervalSec,
        timeoutMs,
        enabled: true,
        hostId: preference.hostId,
        serviceId: preference.serviceId,
        rationale: 'Heuristic parse from plain-English monitor request.',
        confidence: 45,
      };
    }

    const httpTarget = normalizeHttpTarget(
      parseHttpTarget(description) ??
        (lower.includes('https') ? 'https://localhost' : 'http://localhost'),
    );
    return {
      name: keyword ? `HTTP ${httpTarget}` : `HTTP ${httpTarget}`,
      type: 'HTTP',
      target: httpTarget ?? 'http://localhost',
      expectedStatus,
      intervalSec,
      timeoutMs,
      keyword: keyword ?? undefined,
      enabled: true,
      hostId: preference.hostId,
      serviceId: preference.serviceId,
      rationale: 'Heuristic parse from plain-English monitor request.',
      confidence: 45,
    };
  }

  // Applies strict bounds and target normalization to generated monitor drafts.
  private sanitizeMonitorDraft(
    draft: MonitorDraft,
    validHostIds: Set<string>,
    validServiceIds: Set<string>,
    fallback?: MonitorDraft,
  ): MonitorDraft {
    const baseline = fallback ?? {
      name: 'New Monitor',
      type: 'HTTP' as const,
      target: 'http://localhost',
      expectedStatus: 200,
      intervalSec: 60,
      timeoutMs: 2000,
      enabled: true,
    };

    const type = normalizeType(draft.type, baseline.type);
    const rawTarget = sanitizePlainText(draft.target, 500) ?? baseline.target;
    const target =
      type === 'HTTP'
        ? (normalizeHttpTarget(rawTarget) ??
          normalizeHttpTarget(baseline.target) ??
          'http://localhost')
        : type === 'TCP'
          ? (normalizeTcpTarget(rawTarget) ??
            normalizeTcpTarget(baseline.target) ??
            'localhost:443')
          : (normalizeHostOnlyTarget(rawTarget) ??
            normalizeHostOnlyTarget(baseline.target) ??
            '127.0.0.1');
    const expectedStatus =
      type === 'HTTP'
        ? clampInteger(draft.expectedStatus ?? baseline.expectedStatus ?? 200, 100, 599, 200)
        : undefined;
    const intervalSec = clampInteger(draft.intervalSec, 10, 3600, baseline.intervalSec);
    const timeoutMs = clampInteger(draft.timeoutMs, 100, 30000, baseline.timeoutMs);
    const keyword = type === 'HTTP' ? normalizeKeyword(draft.keyword) : undefined;
    const hostId = draft.hostId && validHostIds.has(draft.hostId) ? draft.hostId : undefined;
    const serviceId =
      draft.serviceId && validServiceIds.has(draft.serviceId) ? draft.serviceId : undefined;
    const enabled = typeof draft.enabled === 'boolean' ? draft.enabled : baseline.enabled;
    const safeName = sanitizePlainText(draft.name, 120) ?? defaultNameForDraft(type, target);
    const rationale = sanitizePlainText(draft.rationale, 500);
    const confidence =
      typeof draft.confidence === 'number' && Number.isFinite(draft.confidence)
        ? clampInteger(draft.confidence, 0, 100, 50)
        : undefined;

    return {
      name: safeName,
      type,
      target,
      expectedStatus,
      intervalSec,
      timeoutMs,
      keyword,
      enabled,
      hostId,
      serviceId,
      rationale: rationale ?? undefined,
      confidence,
    };
  }
}

// Converts internal draft shape into monitor create/update payload.
function toCreatePayload(draft: MonitorDraft) {
  return {
    name: draft.name,
    type: draft.type,
    target: draft.target,
    expectedStatus: draft.type === 'HTTP' ? draft.expectedStatus : undefined,
    intervalSec: draft.intervalSec,
    timeoutMs: draft.timeoutMs,
    keyword: draft.type === 'HTTP' ? draft.keyword : undefined,
    enabled: draft.enabled,
    hostId: draft.hostId,
    serviceId: draft.serviceId,
  };
}

// Accepts either a bare draft or an envelope { monitor: ... } from AI output.
function parseAiMonitorDraft(raw: string): MonitorDraft | null {
  const parsedJson = parseJsonObject(raw);
  if (!parsedJson) {
    return null;
  }
  const parsed = aiMonitorParseEnvelopeSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }
  if ('monitor' in parsed.data) {
    return parsed.data.monitor;
  }
  return parsed.data;
}

/**
 * Parses ai monitor suggestions.
 */
function parseAiMonitorSuggestions(raw: string): MonitorDraft[] {
  const parsedJson = parseJsonObject(raw);
  if (!parsedJson) {
    return [];
  }
  const parsed = aiMonitorSuggestionsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.suggestions;
}

// Tolerates responses that wrap JSON in extra text by slicing first/last braces.
function parseJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

/**
 * Builds monitor key.
 */
function buildMonitorKey(type: MonitorType, target: string) {
  return `${type}:${target.trim().toLowerCase()}`;
}

/**
 * Implements normalize type.
 */
function normalizeType(type: string, fallback: MonitorType): MonitorType {
  if (type === 'HTTP' || type === 'TCP' || type === 'ICMP') {
    return type;
  }
  return fallback;
}

/**
 * Implements default name for draft.
 */
function defaultNameForDraft(type: MonitorType, target: string) {
  if (type === 'HTTP') {
    return `HTTP ${target}`;
  }
  if (type === 'TCP') {
    return `TCP ${target}`;
  }
  return `Ping ${target}`;
}

// Normalization helpers keep monitor targets consistent across UI, AI, and jobs.
function normalizeHttpTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed.replace(/^\/\//, '')}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Implements normalize tcp target.
 */
function normalizeTcpTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const hostPortMatch = trimmed.match(/^([a-zA-Z0-9.-]+):(\d{1,5})$/);
  if (hostPortMatch?.[1] && hostPortMatch[2]) {
    const host = hostPortMatch[1];
    const port = Number(hostPortMatch[2]);
    if (!Number.isNaN(port) && port >= 1 && port <= 65535) {
      return `${host}:${port}`;
    }
  }

  const asUrl = normalizeHttpTarget(trimmed);
  if (asUrl) {
    try {
      const parsed = new URL(asUrl);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        return null;
      }
      return `${parsed.hostname}:${port}`;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Implements normalize host only target.
 */
function normalizeHostOnlyTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const hostFromUrl = normalizeHttpTarget(trimmed);
  if (hostFromUrl) {
    try {
      return new URL(hostFromUrl).hostname;
    } catch {
      return null;
    }
  }

  const hostPortMatch = trimmed.match(/^([a-zA-Z0-9.-]+):\d{1,5}$/);
  if (hostPortMatch?.[1]) {
    return hostPortMatch[1];
  }

  if (/^[a-zA-Z0-9.-]+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

/**
 * Parses expected status.
 */
function parseExpectedStatus(description: string) {
  const match = description.match(/\b(status|code)\b[^0-9]{0,10}(\d{3})\b/i);
  if (!match?.[2]) {
    return null;
  }
  const parsed = Number(match[2]);
  if (Number.isNaN(parsed) || parsed < 100 || parsed > 599) {
    return null;
  }
  return parsed;
}

/**
 * Parses interval seconds.
 */
function parseIntervalSeconds(description: string) {
  const match = description.match(
    /\b(every|interval)\s+(\d+)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b/i,
  );
  if (!match?.[2] || !match[3]) {
    return null;
  }

  const amount = Number(match[2]);
  if (Number.isNaN(amount) || amount <= 0) {
    return null;
  }
  const unit = match[3].toLowerCase();

  if (unit.startsWith('ms')) {
    return Math.ceil(amount / 1000);
  }
  if (unit.startsWith('s')) {
    return amount;
  }
  if (unit.startsWith('m')) {
    return amount * 60;
  }
  return amount * 3600;
}

/**
 * Parses timeout millis.
 */
function parseTimeoutMillis(description: string) {
  const match = description.match(
    /\b(timeout|within)\s+(\d+)\s*(ms|milliseconds|s|sec|secs|seconds)\b/i,
  );
  if (!match?.[2] || !match[3]) {
    return null;
  }

  const amount = Number(match[2]);
  if (Number.isNaN(amount) || amount <= 0) {
    return null;
  }
  const unit = match[3].toLowerCase();
  if (unit.startsWith('ms')) {
    return amount;
  }
  return amount * 1000;
}

/**
 * Parses keyword.
 */
function parseKeyword(description: string) {
  const doubleQuoted = description.match(/\b(keyword|contains?|body contains?)\b[^"]*"([^"]+)"/i);
  if (doubleQuoted?.[2]) {
    return doubleQuoted[2];
  }

  const singleQuoted = description.match(/\b(keyword|contains?|body contains?)\b[^']*'([^']+)'/i);
  if (singleQuoted?.[2]) {
    return singleQuoted[2];
  }

  return null;
}

/**
 * Parses http target.
 */
function parseHttpTarget(description: string) {
  const urlMatch = description.match(/https?:\/\/[^\s"'`]+/i);
  if (urlMatch?.[0]) {
    return urlMatch[0];
  }

  const hostPort = description.match(
    /\b([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|localhost)(:\d{1,5})?(\/[^\s"'`]*)?/i,
  );
  if (hostPort?.[0]) {
    return hostPort[0];
  }

  return null;
}

/**
 * Parses tcp target.
 */
function parseTcpTarget(description: string) {
  const hostPort = description.match(/\b([a-zA-Z0-9.-]+):(\d{1,5})\b/);
  if (!hostPort?.[1] || !hostPort[2]) {
    return null;
  }

  const port = Number(hostPort[2]);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return null;
  }

  return `${hostPort[1]}:${port}`;
}

/**
 * Parses host target.
 */
function parseHostTarget(description: string) {
  const ip = description.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  if (ip?.[0]) {
    return ip[0];
  }

  const hostname = description.match(/\b([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|localhost)\b/i);
  if (hostname?.[0]) {
    return hostname[0];
  }

  return null;
}

/**
 * Implements detect monitor type.
 */
function detectMonitorType(description: string): MonitorType {
  const lower = description.toLowerCase();
  if (lower.includes('icmp') || lower.includes('ping')) {
    return 'ICMP';
  }
  if (lower.includes('tcp') || /\bport\s+\d{2,5}\b/i.test(lower)) {
    return 'TCP';
  }
  return 'HTTP';
}

/**
 * Implements clamp integer.
 */
function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.round(value);
  return Math.max(min, Math.min(max, normalized));
}

/**
 * Implements sanitize plain text.
 */
function sanitizePlainText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

/**
 * Implements normalize keyword.
 */
function normalizeKeyword(value: unknown): string | undefined {
  const keyword = sanitizePlainText(value, 240);
  if (!keyword) {
    return undefined;
  }
  if (placeholderKeywordTokens.has(keyword.toLowerCase())) {
    return undefined;
  }
  return keyword;
}

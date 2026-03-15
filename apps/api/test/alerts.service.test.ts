/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the alerts service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  AlertEventStatus: {
    PENDING: 'PENDING',
    FIRING: 'FIRING',
    RESOLVED: 'RESOLVED',
  },
  AlertRuleType: {
    CHECK_DOWN_CONSECUTIVE: 'CHECK_DOWN_CONSECUTIVE',
    HOST_OFFLINE: 'HOST_OFFLINE',
    DISK_USAGE_GT: 'DISK_USAGE_GT',
    RULE_ENGINE: 'RULE_ENGINE',
  },
  CheckResultStatus: {
    DOWN: 'DOWN',
    WARN: 'WARN',
    UNKNOWN: 'UNKNOWN',
  },
  EventSeverity: {
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
  },
  HealthStatus: {
    OK: 'OK',
    WARN: 'WARN',
    CRIT: 'CRIT',
    UNKNOWN: 'UNKNOWN',
  },
}));

import { AlertsService } from '../src/modules/alerts/alerts.service';

/**
 * Creates prisma mock.
 */
function createPrismaMock() {
  return {
    alertRule: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    alertEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    notificationRoute: {
      findMany: vi.fn(),
    },
    silence: {
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    host: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    hostFact: {
      findMany: vi.fn(),
    },
    service: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    check: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    checkResult: {
      findMany: vi.fn(),
    },
    event: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  };
}

describe('AlertsService', () => {
  const eventsService = {
    emit: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };
  const notificationsService = {
    send: vi.fn(),
  };
  const aiProviderService = {
    getClient: vi.fn(),
    getModel: vi.fn(() => 'gpt-5-mini'),
  };

  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AlertsService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createPrismaMock();
    prisma.notificationRoute.findMany.mockResolvedValue([]);
    prisma.silence.findMany.mockResolvedValue([]);
    prisma.event.count.mockResolvedValue(0);
    prisma.host.count.mockResolvedValue(0);
    prisma.service.count.mockResolvedValue(0);
    prisma.check.count.mockResolvedValue(0);
    prisma.alertEvent.count.mockResolvedValue(0);
    aiProviderService.getClient.mockResolvedValue(null);

    service = new AlertsService(
      prisma as never,
      eventsService as never,
      auditService as never,
      notificationsService as never,
      aiProviderService as never,
    );
  });

  it('normalizes legacy check-down rules into structured specs', async () => {
    prisma.alertRule.findMany.mockResolvedValue([
      {
        id: 'rule-1',
        name: 'Check down 3x',
        description: null,
        type: 'CHECK_DOWN_CONSECUTIVE',
        specVersion: 1,
        config: {
          consecutive: 3,
          checkId: '5d6945d8-66ba-4b85-8e1d-cf09dc344648',
        },
        enabled: true,
        createdAt: new Date('2026-03-14T12:00:00.000Z'),
        updatedAt: new Date('2026-03-14T12:05:00.000Z'),
      },
    ]);

    const result = await service.rules();

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.type).toBe('CHECK_DOWN_CONSECUTIVE');
    expect(result.rules[0]?.spec.scope.entity).toBe('check');
    expect(result.rules[0]?.spec.conditions.items[0]).toMatchObject({
      kind: 'check',
      mode: 'consecutive_failures',
      threshold: 3,
    });
  });

  it('returns catalog metadata for the rule builder', async () => {
    prisma.notificationRoute.findMany.mockResolvedValue([
      {
        id: '7ffdb1f2-f0f8-45a2-b8c1-8669bf0b8943',
        name: 'Discord Ops',
        type: 'DISCORD',
      },
    ]);
    prisma.host.findMany.mockResolvedValue([
      {
        id: '5d6945d8-66ba-4b85-8e1d-cf09dc344648',
        hostname: 'cache-node',
        resolvedPrimaryIp: '10.0.0.12',
      },
    ]);
    prisma.service.findMany.mockResolvedValue([
      {
        id: 'c8993dd3-a4ea-44a4-b697-5ef05024c646',
        name: 'Plex',
      },
    ]);
    prisma.check.findMany.mockResolvedValue([
      {
        id: '8377a4a4-1086-4db5-a72d-e9466403f13d',
        name: 'Plex HTTP',
        hostId: '5d6945d8-66ba-4b85-8e1d-cf09dc344648',
        serviceId: 'c8993dd3-a4ea-44a4-b697-5ef05024c646',
      },
    ]);

    const result = await service.catalog();

    expect(result.notificationRoutes[0]).toMatchObject({
      id: '7ffdb1f2-f0f8-45a2-b8c1-8669bf0b8943',
      name: 'Discord Ops',
      type: 'DISCORD',
    });
    expect(result.hosts[0]).toEqual({
      id: '5d6945d8-66ba-4b85-8e1d-cf09dc344648',
      hostname: 'cache-node',
      hostIp: '10.0.0.12',
    });
    expect(result.checks[0]).toMatchObject({
      id: '8377a4a4-1086-4db5-a72d-e9466403f13d',
      hostId: '5d6945d8-66ba-4b85-8e1d-cf09dc344648',
      serviceId: 'c8993dd3-a4ea-44a4-b697-5ef05024c646',
    });
  });

  it('lists resolved incidents while keeping the active summary open-only', async () => {
    prisma.alertEvent.findMany.mockResolvedValue([
      {
        id: 'incident-open',
        ruleId: 'rule-1',
        fingerprint: 'rule-1:host:host-1',
        status: 'FIRING',
        severity: 'ERROR',
        message: 'Host offline',
        labels: {},
        lastValue: {},
        startedAt: new Date('2026-03-14T12:00:00.000Z'),
        lastMatchedAt: new Date('2026-03-14T12:01:00.000Z'),
        lastEvaluatedAt: new Date('2026-03-14T12:01:00.000Z'),
        resolvedAt: null,
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        lastNotifiedAt: null,
        hostId: 'host-1',
        serviceId: null,
        checkId: null,
        groupKey: 'host:host-1',
        rule: { name: 'Host offline' },
        host: { id: 'host-1', hostname: 'db-node' },
        service: null,
        check: null,
      },
      {
        id: 'incident-resolved',
        ruleId: 'rule-2',
        fingerprint: 'rule-2:host:host-2',
        status: 'RESOLVED',
        severity: 'WARN',
        message: 'Disk pressure resolved',
        labels: {},
        lastValue: {},
        startedAt: new Date('2026-03-14T10:00:00.000Z'),
        lastMatchedAt: new Date('2026-03-14T10:05:00.000Z'),
        lastEvaluatedAt: new Date('2026-03-14T10:06:00.000Z'),
        resolvedAt: new Date('2026-03-14T10:06:00.000Z'),
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        lastNotifiedAt: null,
        hostId: 'host-2',
        serviceId: null,
        checkId: null,
        groupKey: 'host:host-2',
        rule: { name: 'Disk pressure' },
        host: { id: 'host-2', hostname: 'nas-01' },
        service: null,
        check: null,
      },
    ]);

    const incidents = await service.listIncidents();
    const active = await service.active();

    expect(incidents.incidents).toHaveLength(2);
    expect(incidents.incidents.map((incident) => incident.state)).toEqual(['FIRING', 'RESOLVED']);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe('incident-open');
  });

  it('previews host metric rules against current host telemetry', async () => {
    prisma.host.findMany.mockResolvedValue([
      {
        id: 'host-1',
        hostname: 'db-node',
        status: 'OK',
        cpuPct: 92,
        memPct: 55,
        diskPct: 71,
        lastSeenAt: new Date('2026-03-14T12:00:00.000Z'),
      },
    ]);

    const result = await service.previewRule({
      rule: {
        name: 'CPU high',
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
              },
            ],
          },
          evaluation: {
            pendingMinutes: 0,
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
      },
    });

    expect(result.summary.candidateCount).toBe(1);
    expect(result.summary.firingCount).toBe(1);
    expect(result.incidents[0]?.host?.name).toBe('db-node');
    expect(result.incidents[0]?.message).toContain('cpuPct');
  });

  it('falls back to heuristic English parsing when AI is disabled', async () => {
    prisma.host.findMany.mockResolvedValue([
      {
        id: '5d6945d8-66ba-4b85-8e1d-cf09dc344648',
        hostname: 'cache-node',
        tags: ['cache'],
      },
    ]);
    prisma.service.findMany.mockResolvedValue([]);
    prisma.check.findMany.mockResolvedValue([]);
    prisma.notificationRoute.findMany.mockResolvedValue([]);

    const parsed = await service.parseRuleDescription('user-1', {
      description: 'Alert when cache-node is offline for 5 minutes',
    });

    expect(parsed.generatedByAi).toBe(false);
    expect(parsed.warnings[0]).toContain('heuristics');
    expect(parsed.draft.spec.scope.entity).toBe('host');
    expect(parsed.draft.spec.scope.hostIds).toEqual(['5d6945d8-66ba-4b85-8e1d-cf09dc344648']);
    expect(parsed.draft.spec.conditions.items[0]).toMatchObject({
      kind: 'state',
      target: 'host_offline',
      staleMinutes: 5,
    });
  });

  it('acknowledges incidents and writes an audit event', async () => {
    prisma.alertEvent.findUnique.mockResolvedValue({
      id: 'incident-1',
      ruleId: 'rule-1',
      fingerprint: 'rule-1:host:host-1',
      status: 'FIRING',
      severity: 'ERROR',
      message: 'Disk is full',
      labels: {},
      lastValue: {},
      startedAt: new Date('2026-03-14T12:00:00.000Z'),
      lastMatchedAt: new Date('2026-03-14T12:00:00.000Z'),
      lastEvaluatedAt: new Date('2026-03-14T12:01:00.000Z'),
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedByUserId: null,
      lastNotifiedAt: null,
      hostId: 'host-1',
      serviceId: null,
      checkId: null,
      groupKey: 'host:host-1',
      rule: { name: 'Disk pressure' },
      host: { id: 'host-1', hostname: 'db-node' },
      service: null,
      check: null,
    });
    prisma.alertEvent.update.mockResolvedValue({
      id: 'incident-1',
      ruleId: 'rule-1',
      fingerprint: 'rule-1:host:host-1',
      status: 'FIRING',
      severity: 'ERROR',
      message: 'Disk is full',
      labels: {},
      lastValue: {},
      startedAt: new Date('2026-03-14T12:00:00.000Z'),
      lastMatchedAt: new Date('2026-03-14T12:00:00.000Z'),
      lastEvaluatedAt: new Date('2026-03-14T12:01:00.000Z'),
      resolvedAt: null,
      acknowledgedAt: new Date('2026-03-14T12:02:00.000Z'),
      acknowledgedByUserId: 'user-1',
      lastNotifiedAt: null,
      hostId: 'host-1',
      serviceId: null,
      checkId: null,
      groupKey: 'host:host-1',
      rule: { name: 'Disk pressure' },
      host: { id: 'host-1', hostname: 'db-node' },
      service: null,
      check: null,
    });

    const acknowledged = await service.acknowledgeIncident('user-1', 'incident-1');

    expect(acknowledged.acknowledgedAt).toBe('2026-03-14T12:02:00.000Z');
    expect(auditService.write).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      action: 'alert_incident.ack',
      targetType: 'alert_event',
      targetId: 'incident-1',
      success: true,
    });
  });
});

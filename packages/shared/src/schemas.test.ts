/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the schemas test behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  authChangePasswordSchema,
  authSetupRequestSchema,
  authSetupStatusSchema,
  agentRecoveryClaimApproveSchema,
  agentRecoveryClaimDenySchema,
  agentRecoveryClaimSchema,
  agentRecoverySummaryResponseSchema,
  aiProviderConfigResponseSchema,
  aiProviderConfigUpdateSchema,
  aiPersonalityUpdateSchema,
  alertCatalogResponseSchema,
  alertParseRequestSchema,
  alertPreviewRequestSchema,
  alertRuleCreateSchema,
  alertRuleUpdateSchema,
  alertSilenceCreateSchema,
  createCheckSchema,
  defaultSidebarNavigationOrderedItemIds,
  dashboardAgentRunDeleteResponseSchema,
  dashboardAgentRunDeleteSchema,
  dashboardAgentRunSummarySchema,
  dashboardOrphanRecoveryNoticeUpdateSchema,
  dashboardSuggestionsNoticeUpdateSchema,
  discoverySubnetsUpdateSchema,
  hiddenHostsUpdateSchema,
  hostListColumnsUpdateSchema,
  hostMetadataResponseSchema,
  hostMetadataUpdateSchema,
  hostTelemetryConfigResponseSchema,
  hostTelemetryConfigUpdateSchema,
  hostTelemetryRefreshRequestSchema,
  notificationRouteCreateSchema,
  serviceDiscoveryCatalogResponseSchema,
  serviceDiscoveryRunDeleteResponseSchema,
  serviceDiscoveryRunDeleteSchema,
  serviceDiscoveryRunHistoryResponseSchema,
  serviceDiscoveryRunRequestSchema,
  serviceDiscoveryRunResponseSchema,
  terminalSshSocketClientMessageSchema,
  terminalSshSocketServerMessageSchema,
  sidebarNavigationUpdateSchema,
  userPreferencesResponseSchema,
  uiThemeSettingsSchema,
  uiThemeSettingsUpdateSchema,
} from './schemas';

describe('authSetupStatusSchema', () => {
  it('accepts the public setup-status payload', () => {
    expect(
      authSetupStatusSchema.parse({
        setupRequired: true,
      }),
    ).toEqual({
      setupRequired: true,
    });
  });
});

describe('authSetupRequestSchema', () => {
  it('requires confirmation and a strong password for first-run setup', () => {
    expect(
      authSetupRequestSchema.safeParse({
        confirm: false,
        password: 'VerySecret123',
      }).success,
    ).toBe(false);

    expect(
      authSetupRequestSchema.safeParse({
        confirm: true,
        password: 'short',
      }).success,
    ).toBe(false);
  });
});

describe('authChangePasswordSchema', () => {
  it('requires confirmation, the current password, and a strong new password', () => {
    expect(
      authChangePasswordSchema.safeParse({
        confirm: false,
        currentPassword: 'CurrentSecret123',
        newPassword: 'NewSecret123',
      }).success,
    ).toBe(false);

    expect(
      authChangePasswordSchema.safeParse({
        confirm: true,
        currentPassword: '',
        newPassword: 'NewSecret123',
      }).success,
    ).toBe(false);
  });
});

describe('createCheckSchema', () => {
  it('validates an HTTP check', () => {
    const parsed = createCheckSchema.parse({
      name: 'Homepage',
      type: 'HTTP',
      target: 'https://example.com',
      intervalSec: 60,
      timeoutMs: 2000,
      expectedStatus: 200,
      enabled: true,
    });

    expect(parsed.type).toBe('HTTP');
  });
});

describe('alertRuleCreateSchema', () => {
  it('accepts a valid host metric alert rule draft', () => {
    const parsed = alertRuleCreateSchema.parse({
      confirm: true,
      name: 'Storage pressure',
      description: 'Warn when any storage node stays above 90% disk usage.',
      enabled: false,
      spec: {
        scope: {
          entity: 'host',
          tags: ['storage'],
        },
        conditions: {
          match: 'ALL',
          items: [
            {
              kind: 'host_metric',
              metric: 'diskPct',
              comparator: 'GT',
              threshold: 90,
              reducer: 'avg',
              windowMinutes: 10,
            },
          ],
        },
        evaluation: {
          pendingMinutes: 5,
          recoveryMinutes: 10,
          noDataBehavior: 'KEEP_STATE',
        },
        severity: 'WARN',
        labels: {
          team: 'infra',
        },
        delivery: {
          routeIds: ['f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981'],
          repeatMinutes: 120,
          sendResolved: true,
        },
      },
    });

    expect(parsed.spec.conditions.items[0]?.kind).toBe('host_metric');
    expect(parsed.spec.delivery.repeatMinutes).toBe(120);
  });
});

describe('alertRuleUpdateSchema', () => {
  it('rejects empty updates', () => {
    const rejected = alertRuleUpdateSchema.safeParse({
      confirm: true,
    });

    expect(rejected.success).toBe(false);
  });
});

describe('alertParseRequestSchema', () => {
  it('accepts optional scoped ids for AI parsing', () => {
    const parsed = alertParseRequestSchema.parse({
      description: 'Alert when cache-node is offline for 5 minutes.',
      hostId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
    });

    expect(parsed.hostId).toBe('f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981');
  });
});

describe('alertPreviewRequestSchema', () => {
  it('accepts preview requests with event-count conditions', () => {
    const parsed = alertPreviewRequestSchema.parse({
      rule: {
        name: 'Critical event burst',
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
                comparator: 'GTE',
                threshold: 3,
                windowMinutes: 15,
                severity: 'ERROR',
              },
            ],
          },
          evaluation: {
            pendingMinutes: 0,
            recoveryMinutes: 5,
            noDataBehavior: 'RESOLVE',
          },
          severity: 'ERROR',
          labels: {},
          delivery: {
            routeIds: [],
            repeatMinutes: 60,
            sendResolved: true,
          },
        },
      },
    });

    expect(parsed.rule.spec.scope.entity).toBe('homelab');
  });
});

describe('alertCatalogResponseSchema', () => {
  it('accepts valid alert catalog payloads', () => {
    const parsed = alertCatalogResponseSchema.parse({
      scopes: ['host', 'check', 'service', 'homelab'],
      matchModes: ['ALL', 'ANY'],
      comparators: ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'],
      reducers: ['latest', 'avg', 'min', 'max'],
      hostMetrics: [{ id: 'cpuPct', label: 'CPU %' }],
      homelabMetrics: [{ id: 'activeAlerts', label: 'Active alerts' }],
      stateTargets: [{ id: 'host_offline', label: 'Host offline' }],
      checkModes: [{ id: 'consecutive_failures', label: 'Consecutive failures' }],
      notificationRoutes: [
        {
          id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
          name: 'Discord Ops',
          type: 'DISCORD',
        },
      ],
      hosts: [
        {
          id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
          hostname: 'nas-01',
          hostIp: '10.0.0.10',
        },
      ],
      services: [
        {
          id: '2f7e2651-5708-46d3-bf53-48c61ecfdf14',
          name: 'Plex',
        },
      ],
      checks: [
        {
          id: '3a297fc3-e728-4280-b390-d34fdbf4de2d',
          name: 'Plex HTTP',
          hostId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
          serviceId: '2f7e2651-5708-46d3-bf53-48c61ecfdf14',
        },
      ],
      ruleDefaults: {
        name: 'CPU saturation',
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
      },
    });

    expect(parsed.notificationRoutes).toHaveLength(1);
  });
});

describe('alertSilenceCreateSchema', () => {
  it('supports incident-level silences with confirmation', () => {
    const parsed = alertSilenceCreateSchema.parse({
      confirm: true,
      targetType: 'ALERT_EVENT',
      targetId: 'incident-1',
      reason: 'Maintenance window',
      endsAt: '2026-02-21T16:00:00.000Z',
    });

    expect(parsed.targetType).toBe('ALERT_EVENT');
  });
});

describe('uiThemeSettingsSchema', () => {
  it('accepts a valid theme payload including preset-aware palettes and styles', () => {
    const parsed = uiThemeSettingsSchema.parse({
      preset: 'neon-grid',
      mode: 'dark',
      palette: 'neon-grid',
      style: 'grid',
    });

    expect(parsed).toEqual({
      preset: 'neon-grid',
      mode: 'dark',
      palette: 'neon-grid',
      style: 'grid',
    });
  });

  it('rejects unsupported preset, palette, style, and mode values', () => {
    const result = uiThemeSettingsSchema.safeParse({
      preset: 'operator' as any,
      mode: 'night',
      palette: 'purple',
      style: 'rounded',
    });

    expect(result.success).toBe(false);
  });
});

describe('uiThemeSettingsUpdateSchema', () => {
  it('requires explicit confirmation before write', () => {
    const rejected = uiThemeSettingsUpdateSchema.safeParse({
      confirm: false,
      theme: {
        preset: 'default',
        mode: 'dark',
        palette: 'ocean',
        style: 'soft',
      },
    });

    expect(rejected.success).toBe(false);
  });
});

describe('dashboardAgentRunDeleteSchema', () => {
  it('requires explicit confirmation before deleting a run', () => {
    const rejected = dashboardAgentRunDeleteSchema.safeParse({
      confirm: false,
    });

    expect(rejected.success).toBe(false);

    const parsed = dashboardAgentRunDeleteSchema.parse({
      confirm: true,
    });

    expect(parsed.confirm).toBe(true);
  });
});

describe('dashboardAgentRunDeleteResponseSchema', () => {
  it('accepts a valid delete response payload', () => {
    const parsed = dashboardAgentRunDeleteResponseSchema.parse({
      ok: true,
      deleted: true,
      runId: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
    });

    expect(parsed.deleted).toBe(true);
  });
});

describe('userPreferencesResponseSchema', () => {
  it('accepts persisted hidden host preferences', () => {
    const parsed = userPreferencesResponseSchema.parse({
      preferences: {
        hiddenHostIds: ['d8ef4d73-c886-43cb-a6af-3eeb587f66af'],
        discoverySubnets: ['192.168.1.0/24'],
        hostListColumns: {
          hiddenColumnIds: ['cpu', 'mem'],
          widths: [
            {
              id: 'hostname',
              widthPx: 280,
            },
            {
              id: 'lastSeen',
              widthPx: 200,
            },
          ],
        },
        dashboardSuggestionsNotice: {
          dismissedFingerprint: 'ab12cd34',
        },
        dashboardOrphanRecoveryNotice: {
          dismissedFingerprint: 'fnv1a-orphan1234',
        },
        sidebarNavigation: {
          orderedItemIds: defaultSidebarNavigationOrderedItemIds.slice(),
        },
      },
      updatedAt: '2026-02-21T12:00:00.000Z',
    });

    expect(parsed.preferences.hiddenHostIds).toHaveLength(1);
    expect(parsed.preferences.discoverySubnets[0]).toBe('192.168.1.0/24');
    expect(parsed.preferences.hostListColumns.hiddenColumnIds).toEqual(['cpu', 'mem']);
    expect(parsed.preferences.dashboardSuggestionsNotice.dismissedFingerprint).toBe('ab12cd34');
    expect(parsed.preferences.dashboardOrphanRecoveryNotice.dismissedFingerprint).toBe(
      'fnv1a-orphan1234',
    );
    expect(parsed.preferences.sidebarNavigation.orderedItemIds).toEqual(
      defaultSidebarNavigationOrderedItemIds,
    );
  });
});

describe('hiddenHostsUpdateSchema', () => {
  it('requires explicit confirmation for hidden host writes', () => {
    const rejected = hiddenHostsUpdateSchema.safeParse({
      confirm: false,
      hiddenHostIds: [],
    });

    expect(rejected.success).toBe(false);
  });
});

describe('hostMetadataUpdateSchema', () => {
  it('requires explicit confirmation and accepts bounded tags + host type', () => {
    const rejected = hostMetadataUpdateSchema.safeParse({
      confirm: false,
      tags: ['edge'],
      hostType: 'MACHINE',
    });
    expect(rejected.success).toBe(false);

    const parsed = hostMetadataUpdateSchema.parse({
      confirm: true,
      tags: ['edge', 'k8s-worker', 'rack-1'],
      hostType: 'CONTAINER',
    });
    expect(parsed.tags).toHaveLength(3);
    expect(parsed.hostType).toBe('CONTAINER');
  });

  it('rejects invalid tag characters', () => {
    const rejected = hostMetadataUpdateSchema.safeParse({
      confirm: true,
      tags: ['bad tag with spaces'],
      hostType: 'MACHINE',
    });
    expect(rejected.success).toBe(false);
  });
});

describe('hostMetadataResponseSchema', () => {
  it('accepts host metadata responses', () => {
    const parsed = hostMetadataResponseSchema.parse({
      hostId: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
      hostName: 'demo-node-1',
      tags: ['edge', 'docker'],
      hostType: 'MACHINE',
      updatedAt: '2026-02-21T12:00:00.000Z',
    });

    expect(parsed.hostType).toBe('MACHINE');
    expect(parsed.tags[0]).toBe('edge');
  });
});

describe('agentRecoveryClaimApproveSchema', () => {
  it('requires explicit confirmation before approving a recovery claim', () => {
    expect(
      agentRecoveryClaimApproveSchema.safeParse({
        confirm: false,
      }).success,
    ).toBe(false);

    expect(
      agentRecoveryClaimApproveSchema.parse({
        confirm: true,
      }).confirm,
    ).toBe(true);
  });
});

describe('agentRecoveryClaimDenySchema', () => {
  it('requires explicit confirmation and a reason before denying a recovery claim', () => {
    expect(
      agentRecoveryClaimDenySchema.safeParse({
        confirm: true,
        reason: '',
      }).success,
    ).toBe(false);

    expect(
      agentRecoveryClaimDenySchema.parse({
        confirm: true,
        reason: 'Fingerprint does not match the expected installation.',
      }).reason,
    ).toContain('Fingerprint');
  });
});

describe('agentRecoveryClaimSchema', () => {
  it('accepts recovery claim payloads returned to the dashboard', () => {
    const parsed = agentRecoveryClaimSchema.parse({
      id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
      recoveryKeyAlg: 'ED25519',
      recoveryKeyFingerprint: 'ed25519:demo-fingerprint',
      hostname: 'demo-node-1',
      primaryIp: '192.168.1.44',
      displayName: 'rack-agent-1',
      endpoint: 'http://192.168.1.44:9001',
      mcpEndpoint: 'http://192.168.1.44:8081',
      agentVersion: 'v0.3.0',
      tags: ['edge', 'rack-1'],
      status: 'PENDING_APPROVAL',
      denialReason: null,
      firstSeenAt: '2026-03-12T12:00:00.000Z',
      lastSeenAt: '2026-03-12T12:03:00.000Z',
      approvedAt: null,
      deniedAt: null,
      completedAt: null,
      createdAt: '2026-03-12T12:00:00.000Z',
      updatedAt: '2026-03-12T12:03:00.000Z',
      agent: null,
      approvedBy: null,
      deniedBy: null,
    });

    expect(parsed.status).toBe('PENDING_APPROVAL');
    expect(parsed.tags).toEqual(['edge', 'rack-1']);
  });
});

describe('terminalSshSocketClientMessageSchema', () => {
  it('accepts input and resize messages and rejects oversized payloads', () => {
    expect(
      terminalSshSocketClientMessageSchema.parse({
        type: 'input',
        data: 'ls -la\r',
      }),
    ).toEqual({
      type: 'input',
      data: 'ls -la\r',
    });

    expect(
      terminalSshSocketClientMessageSchema.parse({
        type: 'resize',
        cols: 120,
        rows: 32,
      }),
    ).toEqual({
      type: 'resize',
      cols: 120,
      rows: 32,
    });

    expect(
      terminalSshSocketClientMessageSchema.safeParse({
        type: 'resize',
        cols: 10,
        rows: 2,
      }).success,
    ).toBe(false);
  });
});

describe('terminalSshSocketServerMessageSchema', () => {
  it('accepts attached and close frames', () => {
    expect(
      terminalSshSocketServerMessageSchema.parse({
        type: 'attached',
        sessionId: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
        target: '192.168.1.44',
        username: 'root',
        port: 22,
        openedAt: '2026-03-08T12:00:00.000Z',
      }).type,
    ).toBe('attached');

    expect(
      terminalSshSocketServerMessageSchema.parse({
        type: 'close',
        reason: 'closed_by_user',
        closedAt: '2026-03-08T12:05:00.000Z',
        sessionId: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
      }).type,
    ).toBe('close');
  });
});

describe('discoverySubnetsUpdateSchema', () => {
  it('requires explicit confirmation and valid cidr blocks', () => {
    const rejected = discoverySubnetsUpdateSchema.safeParse({
      confirm: true,
      discoverySubnets: ['invalid-cidr'],
    });
    expect(rejected.success).toBe(false);

    const parsed = discoverySubnetsUpdateSchema.parse({
      confirm: true,
      discoverySubnets: ['10.0.0.0/24', '192.168.1.0/24'],
    });
    expect(parsed.discoverySubnets).toHaveLength(2);
  });
});

describe('hostListColumnsUpdateSchema', () => {
  it('requires explicit confirmation and valid host-list column preferences', () => {
    const rejected = hostListColumnsUpdateSchema.safeParse({
      confirm: true,
      hostListColumns: {
        hiddenColumnIds: ['hostname'],
        widths: [],
      },
    });
    expect(rejected.success).toBe(false);

    const parsed = hostListColumnsUpdateSchema.parse({
      confirm: true,
      hostListColumns: {
        hiddenColumnIds: ['cpu', 'mem'],
        widths: [
          {
            id: 'hostname',
            widthPx: 260,
          },
        ],
      },
    });
    expect(parsed.hostListColumns.hiddenColumnIds).toEqual(['cpu', 'mem']);
    expect(parsed.hostListColumns.widths[0]?.id).toBe('hostname');
  });
});

describe('dashboardSuggestionsNoticeUpdateSchema', () => {
  it('accepts dismissal fingerprint updates with explicit confirmation', () => {
    const parsed = dashboardSuggestionsNoticeUpdateSchema.parse({
      confirm: true,
      dismissedFingerprint: 'abcd1234',
    });
    expect(parsed.dismissedFingerprint).toBe('abcd1234');
  });
});

describe('dashboardOrphanRecoveryNoticeUpdateSchema', () => {
  it('accepts dismissal fingerprint updates with explicit confirmation', () => {
    const parsed = dashboardOrphanRecoveryNoticeUpdateSchema.parse({
      confirm: true,
      dismissedFingerprint: 'fnv1a-orphan1234',
    });
    expect(parsed.dismissedFingerprint).toBe('fnv1a-orphan1234');
  });
});

describe('agentRecoverySummaryResponseSchema', () => {
  it('accepts pending orphan-recovery dashboard summary payloads', () => {
    const parsed = agentRecoverySummaryResponseSchema.parse({
      pendingApprovalCount: 2,
      pendingApprovalFingerprint: 'fnv1a-orphan1234',
      pendingClaimsPreview: [
        {
          id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
          label: 'rack-agent-1',
          hostname: 'host-alpha',
          lastSeenAt: '2026-03-12T12:05:00.000Z',
        },
      ],
    });

    expect(parsed.pendingApprovalCount).toBe(2);
    expect(parsed.pendingClaimsPreview[0]?.label).toBe('rack-agent-1');
  });
});

describe('sidebarNavigationUpdateSchema', () => {
  it('requires explicit confirmation before persisting nav order', () => {
    const rejected = sidebarNavigationUpdateSchema.safeParse({
      confirm: false,
      orderedItemIds: defaultSidebarNavigationOrderedItemIds,
    });

    expect(rejected.success).toBe(false);

    const parsed = sidebarNavigationUpdateSchema.parse({
      confirm: true,
      orderedItemIds: defaultSidebarNavigationOrderedItemIds,
    });

    expect(parsed.orderedItemIds).toEqual(defaultSidebarNavigationOrderedItemIds);
  });
});

describe('aiPersonalityUpdateSchema', () => {
  it('accepts personality updates with explicit confirmation', () => {
    const parsed = aiPersonalityUpdateSchema.parse({
      confirm: true,
      personality: 'Be concise and operationally focused.',
    });

    expect(parsed.confirm).toBe(true);
    expect(parsed.personality).toContain('operationally focused');
  });
});

describe('aiProviderConfigUpdateSchema', () => {
  it('accepts a confirmed key update', () => {
    const parsed = aiProviderConfigUpdateSchema.parse({
      confirm: true,
      apiKey: 'sk-live-123',
    });

    expect(parsed.confirm).toBe(true);
    expect(parsed.apiKey).toBe('sk-live-123');
  });

  it('accepts explicit key clearing', () => {
    const parsed = aiProviderConfigUpdateSchema.parse({
      confirm: true,
      apiKey: null,
    });

    expect(parsed.apiKey).toBeNull();
  });
});

describe('aiProviderConfigResponseSchema', () => {
  it('accepts safe provider metadata', () => {
    const parsed = aiProviderConfigResponseSchema.parse({
      configured: true,
      model: 'gpt-5-mini',
      updatedAt: '2026-03-14T02:00:00.000Z',
    });

    expect(parsed.configured).toBe(true);
    expect(parsed.model).toBe('gpt-5-mini');
  });
});

describe('notificationRouteCreateSchema', () => {
  it('accepts webhook route creation without email support', () => {
    const parsed = notificationRouteCreateSchema.parse({
      name: 'Ops Discord',
      type: 'DISCORD',
      config: {
        url: 'https://discord.example.invalid/webhook',
      },
      enabled: true,
    });

    expect(parsed.type).toBe('DISCORD');
  });

  it('rejects removed email route types', () => {
    const result = notificationRouteCreateSchema.safeParse({
      name: 'SMTP route',
      type: 'EMAIL',
      config: {
        to: 'ops@example.com',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('hostTelemetryConfigResponseSchema', () => {
  it('accepts telemetry interval config payloads', () => {
    const parsed = hostTelemetryConfigResponseSchema.parse({
      hostId: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
      agentId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      fetchedAt: '2026-02-21T12:00:00.000Z',
      config: {
        heartbeatSec: 15,
        factsSec: 300,
        inventorySec: 60,
        minSec: 5,
        maxSec: 3600,
        updatedAt: '2026-02-21T11:59:00.000Z',
      },
    });

    expect(parsed.config.factsSec).toBe(300);
  });
});

describe('hostTelemetryConfigUpdateSchema', () => {
  it('requires explicit confirmation and at least one interval update', () => {
    const rejected = hostTelemetryConfigUpdateSchema.safeParse({
      confirm: true,
    });

    expect(rejected.success).toBe(false);
  });
});

describe('hostTelemetryRefreshRequestSchema', () => {
  it('requires explicit confirmation for manual refresh', () => {
    const rejected = hostTelemetryRefreshRequestSchema.safeParse({
      confirm: false,
    });

    expect(rejected.success).toBe(false);
  });
});

describe('serviceDiscoveryRunRequestSchema', () => {
  it('requires explicit confirmation before starting discovery', () => {
    const rejected = serviceDiscoveryRunRequestSchema.safeParse({
      confirm: false,
    });

    expect(rejected.success).toBe(false);
  });

  it('accepts optional host selection and no subnet overrides', () => {
    const parsed = serviceDiscoveryRunRequestSchema.parse({
      confirm: true,
      hostId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
    });

    expect(parsed.hostId).toBe('f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981');
  });
});

describe('serviceDiscoveryRunDeleteSchema', () => {
  it('requires explicit confirmation before deleting a discovery run', () => {
    const rejected = serviceDiscoveryRunDeleteSchema.safeParse({
      confirm: false,
    });

    expect(rejected.success).toBe(false);

    const parsed = serviceDiscoveryRunDeleteSchema.parse({
      confirm: true,
    });

    expect(parsed.confirm).toBe(true);
  });
});

describe('serviceDiscoveryRunResponseSchema', () => {
  it('accepts a valid discovery run summary payload', () => {
    const parsed = serviceDiscoveryRunResponseSchema.parse({
      runId: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
      status: 'COMPLETED',
      startedAt: '2026-02-21T12:00:00.000Z',
      finishedAt: '2026-02-21T12:00:08.000Z',
      trigger: 'MANUAL',
      summary: {
        hostCount: 4,
        probeCount: 18,
        detectedCount: 6,
        upsertCount: 6,
        errors: 0,
        subnet: {
          scannerAgents: 2,
          cidrCount: 2,
          hostsScanned: 128,
          hostsReachable: 35,
          detections: 18,
          upserts: 18,
          warnings: [],
        },
      },
    });

    expect(parsed.status).toBe('COMPLETED');
    expect(parsed.summary.upsertCount).toBe(6);
  });
});

describe('serviceDiscoveryRunHistoryResponseSchema', () => {
  it('accepts history payloads with running and completed statuses', () => {
    const parsed = serviceDiscoveryRunHistoryResponseSchema.parse({
      runs: [
        {
          id: 'f1d8f6ec-6e8a-4aa0-8612-9702ce9aa981',
          trigger: 'SCHEDULE',
          triggeredByUserId: null,
          startedAt: '2026-02-21T12:00:00.000Z',
          finishedAt: null,
          status: 'RUNNING',
          hostCount: 0,
          probeCount: 0,
          detectedCount: 0,
          upsertCount: 0,
          errorCount: 0,
          error: null,
          summary: null,
        },
      ],
    });

    expect(parsed.runs[0]?.status).toBe('RUNNING');
  });
});

describe('serviceDiscoveryRunDeleteResponseSchema', () => {
  it('accepts a valid delete response payload', () => {
    const parsed = serviceDiscoveryRunDeleteResponseSchema.parse({
      ok: true,
      deleted: true,
      runId: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
    });

    expect(parsed.deleted).toBe(true);
  });
});

describe('serviceDiscoveryCatalogResponseSchema', () => {
  it('accepts catalog payloads with safe probes', () => {
    const parsed = serviceDiscoveryCatalogResponseSchema.parse({
      id: 'global',
      source: 'HYBRID',
      expiresAt: '2026-02-22T12:00:00.000Z',
      lastError: null,
      serviceCount: 1,
      services: [
        {
          id: 'jenkins',
          name: 'Jenkins',
          aliases: ['jenkins'],
          systemdHints: ['jenkins'],
          containerHints: ['jenkins/jenkins'],
          processHints: ['java -jar jenkins.war'],
          tags: ['ci'],
          probes: [
            {
              protocol: 'http',
              ports: [8080],
              path: '/login',
              statusCodes: [200],
            },
          ],
        },
      ],
    });

    expect(parsed.serviceCount).toBe(1);
    expect(parsed.services[0]?.id).toBe('jenkins');
  });
});

describe('dashboardAgentRunSummarySchema', () => {
  it('accepts openai debug traces with sanitized payloads', () => {
    const parsed = dashboardAgentRunSummarySchema.parse({
      analyzedAt: '2026-03-07T12:00:00.000Z',
      context: {
        hosts: 4,
        monitors: 8,
        services: 12,
        activeAlerts: 1,
        discoveryRunsReviewed: 2,
        aiQuestionsReviewed: 5,
        eventsReviewed: 20,
      },
      notes: ['AI refinement was attempted for final highlight prioritization.'],
      toolCalls: [
        {
          tool: 'ai.synthesis',
          ok: true,
          details: 'Model refined 3 highlight(s).',
        },
      ],
      openAiCalls: [
        {
          id: 'ai-call-1',
          step: 'refine_highlights',
          model: 'gpt-5-mini',
          status: 'completed',
          startedAt: '2026-03-07T12:00:01.000Z',
          finishedAt: '2026-03-07T12:00:02.000Z',
          durationMs: 1000,
          requestPayload: { input: 'redacted' },
          responsePayload: { id: 'resp_123' },
          outputText: '{"highlights":[]}',
          reasoningSummary: ['Compared anomalies against monitor and event context.'],
          usage: {
            inputTokens: 1200,
            outputTokens: 340,
            reasoningTokens: 210,
            totalTokens: 1540,
          },
          error: null,
        },
      ],
    });

    expect(parsed.openAiCalls).toHaveLength(1);
    expect(parsed.openAiCalls[0]?.status).toBe('completed');
  });

  it('rejects unknown openai debug status values', () => {
    const result = dashboardAgentRunSummarySchema.safeParse({
      analyzedAt: '2026-03-07T12:00:00.000Z',
      context: {
        hosts: 0,
        monitors: 0,
        services: 0,
        activeAlerts: 0,
        discoveryRunsReviewed: 0,
        aiQuestionsReviewed: 0,
        eventsReviewed: 0,
      },
      notes: [],
      toolCalls: [],
      openAiCalls: [
        {
          id: 'ai-call-1',
          step: 'refine_highlights',
          model: 'gpt-5-mini',
          status: 'unknown',
          startedAt: '2026-03-07T12:00:01.000Z',
          finishedAt: null,
          durationMs: null,
          requestPayload: null,
          responsePayload: null,
          outputText: null,
          reasoningSummary: [],
          usage: null,
          error: null,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

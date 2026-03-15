/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines the schemas validation and transport schemas.
 */
import { z } from 'zod';

/**
 * Implements health status schema.
 */
export const healthStatusSchema = z.enum(['OK', 'WARN', 'CRIT', 'UNKNOWN']);

/**
 * Checks whether valid ipv4 cidr.
 */
function isValidIpv4Cidr(value: string) {
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) {
    return false;
  }

  const address = parts[0];
  const prefixRaw = parts[1];
  if (!address || !prefixRaw) {
    return false;
  }

  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const octets = address.split('.');
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

const ipv4CidrSchema = z.string().trim().refine(isValidIpv4Cidr, {
  message: 'Expected a valid IPv4 CIDR block (example: 192.168.1.0/24)',
});

/**
 * Implements login request schema.
 */
export const loginRequestSchema = z
  .object({
    password: z.string().min(1),
  })
  .strict();

/**
 * Implements login response schema.
 */
export const loginResponseSchema = z.object({
  accessToken: z.string(),
});

/**
 * Implements auth setup status schema.
 */
export const authSetupStatusSchema = z
  .object({
    setupRequired: z.boolean(),
  })
  .strict();

/**
 * Implements auth setup request schema.
 */
export const authSetupRequestSchema = z
  .object({
    confirm: z.literal(true),
    password: z.string().min(12),
  })
  .strict();

/**
 * Implements auth change password schema.
 */
export const authChangePasswordSchema = z
  .object({
    confirm: z.literal(true),
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12),
  })
  .strict();

/**
 * Implements user schema.
 */
export const userSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string(),
  })
  .strict();

/**
 * Implements host summary schema.
 */
export const hostSummarySchema = z
  .object({
    id: z.string().uuid(),
    hostname: z.string(),
    tags: z.array(z.string()),
    hostType: z.enum(['MACHINE', 'CONTAINER']).optional(),
    status: healthStatusSchema,
    cpuPct: z.number().min(0).max(100),
    memPct: z.number().min(0).max(100),
    diskPct: z.number().min(0).max(100),
    lastSeenAt: z.string().datetime().nullable(),
    agentVersion: z.string().nullable(),
  })
  .strict();

/**
 * Implements host type schema.
 */
export const hostTypeSchema = z.enum(['MACHINE', 'CONTAINER']);

const hostMetadataTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9._:-]+$/, 'Tags may contain letters, numbers, ".", "_", ":", and "-" only');

/**
 * Implements host metadata update schema.
 */
export const hostMetadataUpdateSchema = z
  .object({
    confirm: z.literal(true),
    tags: z.array(hostMetadataTagSchema).max(32),
    hostType: hostTypeSchema,
  })
  .strict();

/**
 * Implements host metadata response schema.
 */
export const hostMetadataResponseSchema = z
  .object({
    hostId: z.string().uuid(),
    hostName: z.string().min(1),
    tags: z.array(hostMetadataTagSchema),
    hostType: hostTypeSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements check type schema.
 */
export const checkTypeSchema = z.enum(['HTTP', 'TCP', 'ICMP']);

/**
 * Creates check schema.
 */
export const createCheckSchema = z
  .object({
    name: z.string().min(1),
    type: checkTypeSchema,
    target: z.string().min(1),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    intervalSec: z.number().int().min(10).max(3600),
    timeoutMs: z.number().int().min(100).max(30000),
    keyword: z.string().optional(),
    enabled: z.boolean().default(true),
    hostId: z.string().uuid().optional(),
    serviceId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Implements alert scope entity schema.
 */
export const alertScopeEntitySchema = z.enum(['host', 'check', 'service', 'homelab']);
/**
 * Implements alert condition match schema.
 */
export const alertConditionMatchSchema = z.enum(['ALL', 'ANY']);
/**
 * Implements alert comparator schema.
 */
export const alertComparatorSchema = z.enum(['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ']);
/**
 * Implements alert reducer schema.
 */
export const alertReducerSchema = z.enum(['latest', 'avg', 'min', 'max']);
/**
 * Implements alert severity schema.
 */
export const alertSeveritySchema = z.enum(['INFO', 'WARN', 'ERROR']);
/**
 * Implements alert no data behavior schema.
 */
export const alertNoDataBehaviorSchema = z.enum(['KEEP_STATE', 'RESOLVE', 'ALERT']);
/**
 * Implements alert host metric schema.
 */
export const alertHostMetricSchema = z.enum([
  'cpuPct',
  'memPct',
  'diskPct',
  'networkKbps',
  'diskIoOps',
]);
/**
 * Implements alert homelab metric schema.
 */
export const alertHomelabMetricSchema = z.enum([
  'hostsOnline',
  'hostsOffline',
  'activeAlerts',
  'failingChecks',
]);
/**
 * Implements alert check mode schema.
 */
export const alertCheckModeSchema = z.enum([
  'consecutive_failures',
  'failures_in_window',
  'latency_gt',
  'http_status_not',
]);
/**
 * Implements alert check result status schema.
 */
export const alertCheckResultStatusSchema = z.enum(['DOWN', 'WARN', 'UNKNOWN']);
/**
 * Implements alert state target schema.
 */
export const alertStateTargetSchema = z.enum(['host_offline', 'service_unhealthy', 'check_down']);
/**
 * Implements alert incident state schema.
 */
export const alertIncidentStateSchema = z.enum(['PENDING', 'FIRING', 'RESOLVED']);
/**
 * Implements alert silence target type schema.
 */
export const alertSilenceTargetTypeSchema = z.enum([
  'ALERT_RULE',
  'CHECK',
  'HOST',
  'SERVICE',
  'ALERT_EVENT',
]);

const alertMetricThresholdBaseSchema = z
  .object({
    comparator: alertComparatorSchema,
    threshold: z.number(),
    reducer: alertReducerSchema.default('latest'),
    windowMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
  })
  .strict();

/**
 * Implements alert scope schema.
 */
export const alertScopeSchema = z
  .object({
    entity: alertScopeEntitySchema,
    hostIds: z.array(z.string().uuid()).max(200).optional(),
    serviceIds: z.array(z.string().uuid()).max(200).optional(),
    checkIds: z.array(z.string().uuid()).max(200).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .strict();

/**
 * Implements alert host metric condition schema.
 */
export const alertHostMetricConditionSchema = alertMetricThresholdBaseSchema.extend({
  kind: z.literal('host_metric'),
  metric: alertHostMetricSchema,
});

/**
 * Implements alert homelab metric condition schema.
 */
export const alertHomelabMetricConditionSchema = z
  .object({
    kind: z.literal('homelab_metric'),
    metric: alertHomelabMetricSchema,
    comparator: alertComparatorSchema,
    threshold: z.number(),
  })
  .strict();

/**
 * Implements alert check condition schema.
 */
export const alertCheckConditionSchema = z
  .object({
    kind: z.literal('check'),
    mode: alertCheckModeSchema,
    status: alertCheckResultStatusSchema.optional(),
    threshold: z.number().int().min(1).max(10_000).optional(),
    sampleSize: z.number().int().min(1).max(10_000).optional(),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    windowMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'http_status_not' && value.expectedStatus === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedStatus'],
        message: 'expectedStatus is required for http_status_not rules',
      });
    }
    if (value.mode !== 'http_status_not' && value.threshold === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['threshold'],
        message: 'threshold is required for this check rule mode',
      });
    }
  });

/**
 * Implements alert state condition schema.
 */
export const alertStateConditionSchema = z
  .object({
    kind: z.literal('state'),
    target: alertStateTargetSchema,
    staleMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
  })
  .strict();

/**
 * Implements alert event count condition schema.
 */
export const alertEventCountConditionSchema = z
  .object({
    kind: z.literal('event_count'),
    comparator: alertComparatorSchema,
    threshold: z.number().int().min(0).max(1_000_000),
    windowMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    eventType: z.string().min(1).max(120).optional(),
    severity: alertSeveritySchema.optional(),
  })
  .strict();

/**
 * Implements alert condition schema.
 */
export const alertConditionSchema = z.union([
  alertHostMetricConditionSchema,
  alertHomelabMetricConditionSchema,
  alertCheckConditionSchema,
  alertStateConditionSchema,
  alertEventCountConditionSchema,
]);

/**
 * Implements alert condition group schema.
 */
export const alertConditionGroupSchema = z
  .object({
    match: alertConditionMatchSchema.default('ALL'),
    items: z.array(alertConditionSchema).min(1).max(20),
  })
  .strict();

/**
 * Implements alert evaluation schema.
 */
export const alertEvaluationSchema = z
  .object({
    pendingMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .default(0),
    recoveryMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .default(0),
    noDataBehavior: alertNoDataBehaviorSchema.default('KEEP_STATE'),
  })
  .strict();

/**
 * Implements alert delivery schema.
 */
export const alertDeliverySchema = z
  .object({
    routeIds: z.array(z.string().uuid()).max(50).default([]),
    repeatMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .default(60),
    sendResolved: z.boolean().default(true),
  })
  .strict();

/**
 * Implements alert rule spec schema.
 */
export const alertRuleSpecSchema = z
  .object({
    scope: alertScopeSchema,
    conditions: alertConditionGroupSchema,
    evaluation: alertEvaluationSchema.default({}),
    severity: alertSeveritySchema.default('ERROR'),
    labels: z.record(z.string().min(1).max(64)).default({}),
    delivery: alertDeliverySchema.default({}),
  })
  .strict();

/**
 * Implements alert rule draft schema.
 */
export const alertRuleDraftSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(2000).optional(),
    enabled: z.boolean().default(false),
    spec: alertRuleSpecSchema,
  })
  .strict();

/**
 * Implements alert rule create schema.
 */
export const alertRuleCreateSchema = z
  .object({
    confirm: z.literal(true),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(2000).optional(),
    enabled: z.boolean().default(false),
    spec: alertRuleSpecSchema,
  })
  .strict();

/**
 * Implements alert rule update schema.
 */
export const alertRuleUpdateSchema = z
  .object({
    confirm: z.literal(true),
    name: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(2000).optional(),
    enabled: z.boolean().optional(),
    spec: alertRuleSpecSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.enabled !== undefined ||
      value.spec !== undefined,
    {
      message: 'At least one alert rule field must be provided',
      path: ['name'],
    },
  );

/**
 * Implements alert rule delete schema.
 */
export const alertRuleDeleteSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements alert incident acknowledge schema.
 */
export const alertIncidentAcknowledgeSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements alert parse request schema.
 */
export const alertParseRequestSchema = z
  .object({
    description: z.string().min(1).max(2000),
    hostId: z.string().uuid().optional(),
    serviceId: z.string().uuid().optional(),
    checkId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Implements alert preview request schema.
 */
export const alertPreviewRequestSchema = z
  .object({
    rule: alertRuleDraftSchema,
  })
  .strict();

const alertRouteSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(200),
    type: z.string().min(1).max(40),
  })
  .strict();

/**
 * Implements the alert catalog metric option schema workflow for this file.
 */
const alertCatalogMetricOptionSchema = <T extends z.ZodTypeAny>(idSchema: T) =>
  z
    .object({
      id: idSchema,
      label: z.string().min(1).max(120),
      description: z.string().min(1).max(240).optional(),
    })
    .strict();

const alertCatalogHostSummarySchema = z
  .object({
    id: z.string().uuid(),
    hostname: z.string().min(1).max(255),
    hostIp: z.string().min(1).max(255).nullable(),
  })
  .strict();

const alertCatalogServiceSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
  })
  .strict();

const alertCatalogCheckSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    hostId: z.string().uuid().nullable().optional(),
    serviceId: z.string().uuid().nullable().optional(),
  })
  .strict();

const alertRuleEntitySummarySchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(255),
  })
  .strict();

/**
 * Implements alert incident schema.
 */
export const alertIncidentSchema = z
  .object({
    id: z.string().uuid(),
    ruleId: z.string().uuid(),
    ruleName: z.string().min(1).max(120),
    fingerprint: z.string().min(1).max(255),
    state: alertIncidentStateSchema,
    severity: alertSeveritySchema,
    message: z.string().min(1).max(500),
    startedAt: z.string().datetime(),
    lastMatchedAt: z.string().datetime().nullable(),
    lastEvaluatedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    acknowledgedAt: z.string().datetime().nullable(),
    labels: z.record(z.string().min(1).max(64)).default({}),
    values: z.record(z.unknown()).default({}),
    host: alertRuleEntitySummarySchema.nullable(),
    service: alertRuleEntitySummarySchema.nullable(),
    check: alertRuleEntitySummarySchema.nullable(),
  })
  .strict();

/**
 * Implements alert rule summary schema.
 */
export const alertRuleSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    description: z.string().nullable(),
    enabled: z.boolean(),
    specVersion: z.number().int().min(1),
    type: z.string().min(1).max(40),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    spec: alertRuleSpecSchema,
  })
  .strict();

/**
 * Implements alert catalog response schema.
 */
export const alertCatalogResponseSchema = z
  .object({
    scopes: z.array(alertScopeEntitySchema),
    matchModes: z.array(alertConditionMatchSchema),
    comparators: z.array(alertComparatorSchema),
    reducers: z.array(alertReducerSchema),
    hostMetrics: z.array(alertCatalogMetricOptionSchema(alertHostMetricSchema)),
    homelabMetrics: z.array(alertCatalogMetricOptionSchema(alertHomelabMetricSchema)),
    stateTargets: z.array(alertCatalogMetricOptionSchema(alertStateTargetSchema)),
    checkModes: z.array(alertCatalogMetricOptionSchema(alertCheckModeSchema)),
    notificationRoutes: z.array(alertRouteSummarySchema),
    hosts: z.array(alertCatalogHostSummarySchema),
    services: z.array(alertCatalogServiceSummarySchema),
    checks: z.array(alertCatalogCheckSummarySchema),
    ruleDefaults: alertRuleDraftSchema,
  })
  .strict();

/**
 * Implements alert parse response schema.
 */
export const alertParseResponseSchema = z
  .object({
    aiEnabled: z.boolean(),
    generatedByAi: z.boolean(),
    warnings: z.array(z.string().min(1).max(200)).max(50).default([]),
    rationale: z.string().min(1).max(500).nullable(),
    confidence: z.number().int().min(0).max(100).nullable(),
    draft: alertRuleDraftSchema,
  })
  .strict();

/**
 * Implements alert preview incident schema.
 */
export const alertPreviewIncidentSchema = z
  .object({
    fingerprint: z.string().min(1).max(255),
    state: alertIncidentStateSchema,
    severity: alertSeveritySchema,
    message: z.string().min(1).max(500),
    values: z.record(z.unknown()).default({}),
    host: alertRuleEntitySummarySchema.nullable(),
    service: alertRuleEntitySummarySchema.nullable(),
    check: alertRuleEntitySummarySchema.nullable(),
  })
  .strict();

/**
 * Implements alert preview response schema.
 */
export const alertPreviewResponseSchema = z
  .object({
    evaluatedAt: z.string().datetime(),
    summary: z
      .object({
        candidateCount: z.number().int().nonnegative(),
        matchedCount: z.number().int().nonnegative(),
        firingCount: z.number().int().nonnegative(),
        pendingCount: z.number().int().nonnegative(),
      })
      .strict(),
    incidents: z.array(alertPreviewIncidentSchema),
  })
  .strict();

/**
 * Implements alert rules response schema.
 */
export const alertRulesResponseSchema = z
  .object({
    rules: z.array(alertRuleSummarySchema),
  })
  .strict();

/**
 * Implements alert incidents response schema.
 */
export const alertIncidentsResponseSchema = z
  .object({
    incidents: z.array(alertIncidentSchema),
  })
  .strict();

/**
 * Implements alert silence create schema.
 */
export const alertSilenceCreateSchema = z
  .object({
    confirm: z.literal(true),
    targetType: alertSilenceTargetTypeSchema,
    targetId: z.string().min(1).max(255),
    reason: z.string().min(1).max(500),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements integration type schema.
 */
export const integrationTypeSchema = z.enum(['PROXMOX']);

/**
 * Implements integration schema.
 */
export const integrationSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: integrationTypeSchema,
    enabled: z.boolean(),
    baseUrl: z.string().url(),
    allowInsecureTls: z.boolean(),
    apiTokenId: z.string().min(1).nullable(),
    hasApiTokenSecret: z.boolean(),
    lastSyncAt: z.string().datetime().nullable(),
    lastStatus: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements integration upsert schema.
 */
export const integrationUpsertSchema = z
  .object({
    confirm: z.literal(true),
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(255),
    enabled: z.boolean().default(true),
    baseUrl: z.string().url(),
    apiTokenId: z.string().min(1).max(255),
    apiTokenSecret: z.string().max(512).optional(),
    allowInsecureTls: z.boolean().default(false),
  })
  .strict();

/**
 * Implements integration action request schema.
 */
export const integrationActionRequestSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements integration delete schema.
 */
export const integrationDeleteSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements integration test response schema.
 */
export const integrationTestResponseSchema = z
  .object({
    ok: z.boolean(),
    details: z.record(z.unknown()),
  })
  .strict();

/**
 * Implements integration sync response schema.
 */
export const integrationSyncResponseSchema = z
  .object({
    ok: z.literal(true),
    count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Implements integration delete response schema.
 */
export const integrationDeleteResponseSchema = z
  .object({
    ok: z.literal(true),
    integrationId: z.string().uuid(),
    deletedServiceCount: z.number().int().nonnegative(),
    deletedServiceInstanceCount: z.number().int().nonnegative(),
    deletedHostCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Implements proxmox guest kind schema.
 */
export const proxmoxGuestKindSchema = z.enum(['qemu', 'lxc']);

/**
 * Implements proxmox guest action schema.
 */
export const proxmoxGuestActionSchema = z.enum(['start', 'shutdown', 'stop', 'reboot']);

/**
 * Implements proxmox guest summary schema.
 */
export const proxmoxGuestSummarySchema = z
  .object({
    id: z.string().min(1),
    vmid: z.number().int().nonnegative(),
    kind: proxmoxGuestKindSchema,
    name: z.string().min(1),
    node: z.string().min(1),
    status: z.string().min(1),
    template: z.boolean(),
    locked: z.boolean(),
    tags: z.array(z.string()),
    cpu: z.number().nullable(),
    maxCpu: z.number().int().positive().nullable(),
    memoryBytes: z.number().nonnegative().nullable(),
    maxMemoryBytes: z.number().nonnegative().nullable(),
    diskBytes: z.number().nonnegative().nullable(),
    maxDiskBytes: z.number().nonnegative().nullable(),
    uptimeSeconds: z.number().nonnegative().nullable(),
  })
  .strict();

/**
 * Implements proxmox guest inventory response schema.
 */
export const proxmoxGuestInventoryResponseSchema = z
  .object({
    integration: integrationSchema,
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        stopped: z.number().int().nonnegative(),
        qemu: z.number().int().nonnegative(),
        lxc: z.number().int().nonnegative(),
      })
      .strict(),
    filters: z
      .object({
        nodes: z.array(z.string()),
      })
      .strict(),
    guests: z.array(proxmoxGuestSummarySchema),
  })
  .strict();

/**
 * Implements proxmox guest detail schema.
 */
export const proxmoxGuestDetailSchema = z
  .object({
    integration: integrationSchema,
    guest: proxmoxGuestSummarySchema.extend({
      rawStatus: z.record(z.unknown()),
      rawConfig: z.record(z.unknown()),
      displayConfig: z.array(
        z
          .object({
            label: z.string().min(1),
            value: z.string().min(1),
          })
          .strict(),
      ),
    }),
  })
  .strict();

/**
 * Implements proxmox task summary schema.
 */
export const proxmoxTaskSummarySchema = z
  .object({
    upid: z.string().min(1),
    node: z.string().min(1),
    status: z.string().nullable(),
    exitStatus: z.string().nullable(),
    type: z.string().nullable(),
    user: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    description: z.string().nullable(),
  })
  .strict();

/**
 * Implements proxmox task list response schema.
 */
export const proxmoxTaskListResponseSchema = z
  .object({
    integration: integrationSchema,
    tasks: z.array(proxmoxTaskSummarySchema),
  })
  .strict();

/**
 * Implements proxmox guest action request schema.
 */
export const proxmoxGuestActionRequestSchema = integrationActionRequestSchema;

/**
 * Implements proxmox guest action response schema.
 */
export const proxmoxGuestActionResponseSchema = z
  .object({
    ok: z.literal(true),
    upid: z.string().min(1),
  })
  .strict();

/**
 * Implements tool proposal status schema.
 */
export const toolProposalStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXECUTED',
  'FAILED',
]);

/**
 * Creates tool proposal schema.
 */
export const createToolProposalSchema = z
  .object({
    agentId: z.string().uuid(),
    toolName: z.string().min(1),
    params: z.record(z.unknown()),
    reason: z.string().min(1),
    highRiskConfirmed: z.boolean().optional(),
  })
  .strict();

/**
 * Implements agent install action schema.
 */
export const agentInstallActionSchema = z.enum(['INSTALL', 'ROLLBACK']);
/**
 * Implements agent install status schema.
 */
export const agentInstallStatusSchema = z.enum([
  'PENDING_APPROVAL',
  'APPROVED_AWAITING_EXECUTION',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'DENIED',
]);
/**
 * Implements agent install auth mode schema.
 */
export const agentInstallAuthModeSchema = z.enum(['KEY', 'PASSWORD']);

/**
 * Creates agent install request schema.
 */
export const createAgentInstallRequestSchema = z
  .object({
    confirm: z.literal(true),
    action: agentInstallActionSchema.default('INSTALL'),
    targetHostId: z.string().uuid().optional(),
    targetHost: z.string().min(1).max(255),
    targetPort: z.number().int().min(1).max(65535).default(22),
    targetUsername: z.string().min(1).max(128),
    authMode: agentInstallAuthModeSchema,
    binaryVersion: z.string().min(1).max(64).default('v0.2.0'),
    controlPlaneUrl: z.string().url(),
    mcpBind: z.string().min(1).max(64).default('0.0.0.0'),
    mcpPort: z.number().int().min(1).max(65535).default(8081),
    mcpAdvertiseUrl: z.string().url(),
    allowedOrigins: z.string().min(1).max(1000).default('http://localhost:5173'),
    allowInsecureDev: z.boolean().default(true),
    replaceExisting: z.boolean().default(true),
    installPath: z.string().min(1).max(255).default('/usr/local/bin/labagent'),
    serviceName: z.string().min(1).max(100).default('labagent'),
    rollbackOfRequestId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Implements agent install approve schema.
 */
export const agentInstallApproveSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements agent install uninstall from agent schema.
 */
export const agentInstallUninstallFromAgentSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements agent install deny schema.
 */
export const agentInstallDenySchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

/**
 * Implements launch agent install request schema.
 */
export const launchAgentInstallRequestSchema = z
  .object({
    confirm: z.literal(true),
    authMode: agentInstallAuthModeSchema,
    sshPrivateKey: z.string().max(100_000).optional(),
    sshPassword: z.string().max(1024).optional(),
    sudoPassword: z.string().max(1024).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.authMode === 'KEY' &&
      (!value.sshPrivateKey || value.sshPrivateKey.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sshPrivateKey'],
        message: 'sshPrivateKey is required when authMode is KEY',
      });
    }
    if (
      value.authMode === 'PASSWORD' &&
      (!value.sshPassword || value.sshPassword.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sshPassword'],
        message: 'sshPassword is required when authMode is PASSWORD',
      });
    }
  });

/**
 * Implements agent install request log schema.
 */
export const agentInstallRequestLogSchema = z
  .object({
    id: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    phase: z.string().min(1),
    level: z.string().min(1),
    message: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements agent install request schema.
 */
export const agentInstallRequestSchema = z
  .object({
    id: z.string().uuid(),
    action: agentInstallActionSchema,
    status: agentInstallStatusSchema,
    requestedByUserId: z.string().uuid(),
    approvedByUserId: z.string().uuid().nullable(),
    deniedByUserId: z.string().uuid().nullable(),
    targetHostId: z.string().uuid().nullable(),
    targetHost: z.string(),
    targetPort: z.number().int(),
    targetUsername: z.string(),
    authMode: agentInstallAuthModeSchema,
    binaryVersion: z.string(),
    binaryUrlResolved: z.string().nullable(),
    controlPlaneUrl: z.string(),
    mcpBind: z.string(),
    mcpPort: z.number().int(),
    mcpAdvertiseUrl: z.string(),
    allowedOrigins: z.string(),
    allowInsecureDev: z.boolean(),
    replaceExisting: z.boolean(),
    installPath: z.string(),
    serviceName: z.string(),
    rollbackOfRequestId: z.string().uuid().nullable(),
    resultCode: z.string().nullable(),
    resultSummary: z.string().nullable(),
    errorMessageSanitized: z.string().nullable(),
    agentIdLinked: z.string().uuid().nullable(),
    approvedAt: z.string().datetime().nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    deniedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    logs: z.array(agentInstallRequestLogSchema).optional(),
  })
  .strict();

/**
 * Implements agent install list response schema.
 */
export const agentInstallListResponseSchema = z
  .object({
    requests: z.array(agentInstallRequestSchema),
  })
  .strict();

/**
 * Implements agent install binary manifest item schema.
 */
export const agentInstallBinaryManifestItemSchema = z
  .object({
    version: z.string().min(1),
    platform: z.enum(['linux-amd64', 'linux-arm64']),
    available: z.boolean(),
  })
  .strict();

/**
 * Implements agent install binary manifest response schema.
 */
export const agentInstallBinaryManifestResponseSchema = z
  .object({
    enabled: z.boolean(),
    source: z.literal('CONTAINER_STORE'),
    storeRootConfigured: z.boolean(),
    defaultVersion: z.string().min(1),
    binaries: z.array(agentInstallBinaryManifestItemSchema),
  })
  .strict();

/**
 * Implements agent recovery claim status schema.
 */
export const agentRecoveryClaimStatusSchema = z.enum([
  'PENDING_APPROVAL',
  'APPROVED_PENDING_AGENT',
  'DENIED',
  'COMPLETED',
]);

const agentRecoveryClaimActorSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string(),
  })
  .strict();

const agentRecoveryLinkedAgentSchema = z
  .object({
    id: z.string().uuid(),
    hostId: z.string().uuid().nullable(),
    status: z.string(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Implements agent recovery claim schema.
 */
export const agentRecoveryClaimSchema = z
  .object({
    id: z.string().uuid(),
    recoveryKeyAlg: z.string().min(1),
    recoveryKeyFingerprint: z.string().min(1),
    hostname: z.string().min(1),
    primaryIp: z.string().nullable(),
    displayName: z.string().nullable(),
    endpoint: z.string().url(),
    mcpEndpoint: z.string().url(),
    agentVersion: z.string().nullable(),
    tags: z.array(z.string()),
    status: agentRecoveryClaimStatusSchema,
    denialReason: z.string().nullable(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    approvedAt: z.string().datetime().nullable(),
    deniedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    agent: agentRecoveryLinkedAgentSchema.nullable(),
    approvedBy: agentRecoveryClaimActorSchema.nullable(),
    deniedBy: agentRecoveryClaimActorSchema.nullable(),
  })
  .strict();

/**
 * Implements agent recovery summary preview item schema.
 */
export const agentRecoverySummaryPreviewItemSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().min(1).max(255),
    hostname: z.string().min(1).max(255),
    lastSeenAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements agent recovery summary response schema.
 */
export const agentRecoverySummaryResponseSchema = z
  .object({
    pendingApprovalCount: z.number().int().nonnegative(),
    pendingApprovalFingerprint: z.string().min(1).max(256).nullable(),
    pendingClaimsPreview: z.array(agentRecoverySummaryPreviewItemSchema).max(5),
  })
  .strict();

/**
 * Implements agent recovery claim approve schema.
 */
export const agentRecoveryClaimApproveSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements agent recovery claim deny schema.
 */
export const agentRecoveryClaimDenySchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().min(1).max(500),
  })
  .strict();

/**
 * Implements ai chat request schema.
 */
export const aiChatRequestSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().min(1),
    contextHostId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Implements mcp tool call schema.
 */
export const mcpToolCallSchema = z
  .object({
    agentId: z.string().uuid(),
    toolName: z.string().min(1),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

/**
 * Implements monitor parse request schema.
 */
export const monitorParseRequestSchema = z
  .object({
    description: z.string().min(1).max(2000),
    hostId: z.string().uuid().optional(),
    serviceId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Implements terminal execute request schema.
 */
export const terminalExecuteRequestSchema = z
  .object({
    command: z.string().min(1).max(240),
  })
  .strict();

/**
 * Implements terminal ssh session create request schema.
 */
export const terminalSshSessionCreateRequestSchema = z
  .object({
    confirm: z.literal(true),
    username: z.string().min(1).max(64).optional(),
    target: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    password: z.string().max(512).optional(),
  })
  .strict();

/**
 * Implements terminal ssh session input request schema.
 */
export const terminalSshSessionInputRequestSchema = z
  .object({
    data: z.string().max(4096),
    appendNewline: z.boolean().optional(),
  })
  .strict();

/**
 * Implements terminal ssh socket client message schema.
 */
export const terminalSshSocketClientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('input'),
      data: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      cols: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(200),
    })
    .strict(),
]);

/**
 * Implements terminal ssh socket server message schema.
 */
export const terminalSshSocketServerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('attached'),
      sessionId: z.string().uuid(),
      target: z.string().min(1),
      username: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      openedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      type: z.literal('output'),
      chunk: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      message: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal('close'),
      reason: z.string().min(1).max(200),
      closedAt: z.string().datetime(),
      sessionId: z.string().uuid(),
    })
    .strict(),
]);

/**
 * Implements tool proposal approve schema.
 */
export const toolProposalApproveSchema = z
  .object({
    secondConfirm: z.boolean().optional(),
  })
  .strict();

/**
 * Implements tool proposal deny schema.
 */
export const toolProposalDenySchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

/**
 * Implements ai conversation retention schema.
 */
export const aiConversationRetentionSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(365),
  })
  .strict();

/**
 * Implements ai personality update schema.
 */
export const aiPersonalityUpdateSchema = z
  .object({
    confirm: z.literal(true),
    personality: z.string().max(6000),
  })
  .strict();

/**
 * Implements ai personality schema.
 */
export const aiPersonalitySchema = z
  .object({
    personality: z.string(),
    isCustom: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Implements ai provider config update schema.
 */
export const aiProviderConfigUpdateSchema = z
  .object({
    confirm: z.literal(true),
    apiKey: z.string().min(1).max(4096).nullable(),
  })
  .strict();

/**
 * Implements ai provider config response schema.
 */
export const aiProviderConfigResponseSchema = z
  .object({
    configured: z.boolean(),
    model: z.string(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Implements notification route type schema.
 */
export const notificationRouteTypeSchema = z.enum(['WEBHOOK', 'DISCORD']);

/**
 * Implements notification route create schema.
 */
export const notificationRouteCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: notificationRouteTypeSchema,
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Implements ui theme preset schema.
 */
export const uiThemePresetSchema = z.enum([
  'default',
  'starship-ops',
  'luxury-ai',
  'neon-grid',
  'holographic-desk',
  'imperial-tactical',
  'matrix-lattice',
  'custom',
]);
/**
 * Implements ui theme mode schema.
 */
export const uiThemeModeSchema = z.enum(['light', 'dark']);
/**
 * Implements ui theme palette schema.
 */
export const uiThemePaletteSchema = z.enum([
  'ocean',
  'forest',
  'sunset',
  'graphite',
  'aurora',
  'ember',
  'arctic',
  'starship-ops',
  'luxury-ai',
  'neon-grid',
  'holographic-desk',
  'imperial-tactical',
  'matrix-lattice',
]);
/**
 * Implements ui theme style schema.
 */
export const uiThemeStyleSchema = z.enum([
  'soft',
  'glass',
  'contrast',
  'industrial',
  'luxe',
  'grid',
  'holographic',
  'tactical',
  'lattice',
]);

/**
 * Implements ui theme settings schema.
 */
export const uiThemeSettingsSchema = z
  .object({
    preset: uiThemePresetSchema,
    mode: uiThemeModeSchema,
    palette: uiThemePaletteSchema,
    style: uiThemeStyleSchema,
  })
  .strict();

/**
 * Implements ui theme settings update schema.
 */
export const uiThemeSettingsUpdateSchema = z
  .object({
    confirm: z.literal(true),
    theme: uiThemeSettingsSchema,
  })
  .strict();

/**
 * Implements ui theme settings response schema.
 */
export const uiThemeSettingsResponseSchema = z
  .object({
    theme: uiThemeSettingsSchema,
    isCustom: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Implements host list column id schema.
 */
export const hostListColumnIdSchema = z.enum([
  'index',
  'hostname',
  'ip',
  'tags',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'lastSeen',
  'agentVersion',
  'visibility',
  'terminal',
]);

/**
 * Implements host list hideable column id schema.
 */
export const hostListHideableColumnIdSchema = z.enum([
  'ip',
  'tags',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'lastSeen',
  'agentVersion',
  'visibility',
]);

const hostListColumnWidthSchema = z
  .object({
    id: hostListColumnIdSchema,
    widthPx: z.number().int().min(80).max(640),
  })
  .strict();

/**
 * Implements host list columns preferences schema.
 */
export const hostListColumnsPreferencesSchema = z
  .object({
    hiddenColumnIds: z.array(hostListHideableColumnIdSchema).max(10),
    widths: z.array(hostListColumnWidthSchema).max(13),
  })
  .strict();

/**
 * Implements dashboard suggestions notice schema.
 */
export const dashboardSuggestionsNoticeSchema = z
  .object({
    dismissedFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict();

/**
 * Implements dashboard orphan recovery notice schema.
 */
export const dashboardOrphanRecoveryNoticeSchema = z
  .object({
    dismissedFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict();

/**
 * Implements sidebar nav item ids.
 */
export const sidebarNavItemIds = [
  'dashboard',
  'dashboard-agent',
  'hosts',
  'proxmox',
  'network-monitors',
  'alerts',
  'service-discovery',
  'agent-management',
  'ai',
  'settings',
] as const;

/**
 * Implements default sidebar navigation ordered item ids.
 */
export const defaultSidebarNavigationOrderedItemIds = [...sidebarNavItemIds];

/**
 * Implements sidebar nav item id schema.
 */
export const sidebarNavItemIdSchema = z.enum(sidebarNavItemIds);

/**
 * Implements sidebar navigation preferences schema.
 */
export const sidebarNavigationPreferencesSchema = z
  .object({
    orderedItemIds: z.array(sidebarNavItemIdSchema).max(sidebarNavItemIds.length),
  })
  .strict();

/**
 * Implements user preferences schema.
 */
export const userPreferencesSchema = z
  .object({
    hiddenHostIds: z.array(z.string().uuid()).max(5000),
    discoverySubnets: z.array(ipv4CidrSchema).max(128),
    hostListColumns: hostListColumnsPreferencesSchema,
    dashboardSuggestionsNotice: dashboardSuggestionsNoticeSchema,
    dashboardOrphanRecoveryNotice: dashboardOrphanRecoveryNoticeSchema,
    sidebarNavigation: sidebarNavigationPreferencesSchema,
  })
  .strict();

/**
 * Implements user preferences response schema.
 */
export const userPreferencesResponseSchema = z
  .object({
    preferences: userPreferencesSchema,
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Implements hidden hosts update schema.
 */
export const hiddenHostsUpdateSchema = z
  .object({
    confirm: z.literal(true),
    hiddenHostIds: z.array(z.string().uuid()).max(5000),
  })
  .strict();

/**
 * Implements discovery subnets update schema.
 */
export const discoverySubnetsUpdateSchema = z
  .object({
    confirm: z.literal(true),
    discoverySubnets: z.array(ipv4CidrSchema).max(128),
  })
  .strict();

/**
 * Implements host list columns update schema.
 */
export const hostListColumnsUpdateSchema = z
  .object({
    confirm: z.literal(true),
    hostListColumns: hostListColumnsPreferencesSchema,
  })
  .strict();

/**
 * Implements dashboard suggestions notice update schema.
 */
export const dashboardSuggestionsNoticeUpdateSchema = z
  .object({
    confirm: z.literal(true),
    dismissedFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict();

/**
 * Implements dashboard orphan recovery notice update schema.
 */
export const dashboardOrphanRecoveryNoticeUpdateSchema = z
  .object({
    confirm: z.literal(true),
    dismissedFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict();

/**
 * Implements sidebar navigation update schema.
 */
export const sidebarNavigationUpdateSchema = z
  .object({
    confirm: z.literal(true),
    orderedItemIds: z.array(sidebarNavItemIdSchema).max(sidebarNavItemIds.length),
  })
  .strict();

/**
 * Implements host telemetry config schema.
 */
export const hostTelemetryConfigSchema = z
  .object({
    heartbeatSec: z.number().int().min(5).max(3600),
    factsSec: z.number().int().min(5).max(3600),
    inventorySec: z.number().int().min(5).max(3600),
    minSec: z.number().int().min(1),
    maxSec: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements host telemetry config response schema.
 */
export const hostTelemetryConfigResponseSchema = z
  .object({
    hostId: z.string().uuid(),
    agentId: z.string().uuid(),
    config: hostTelemetryConfigSchema,
    fetchedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements host telemetry config update schema.
 */
export const hostTelemetryConfigUpdateSchema = z
  .object({
    confirm: z.literal(true),
    heartbeatSec: z.number().int().min(5).max(3600).optional(),
    factsSec: z.number().int().min(5).max(3600).optional(),
    inventorySec: z.number().int().min(5).max(3600).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.heartbeatSec !== undefined ||
      value.factsSec !== undefined ||
      value.inventorySec !== undefined,
    {
      message: 'At least one telemetry interval must be provided',
      path: ['heartbeatSec'],
    },
  );

/**
 * Implements host telemetry refresh request schema.
 */
export const hostTelemetryRefreshRequestSchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * Implements host telemetry refresh response schema.
 */
export const hostTelemetryRefreshResponseSchema = z
  .object({
    hostId: z.string().uuid(),
    agentId: z.string().uuid(),
    queued: z.boolean(),
    reason: z.string().min(1).max(120),
    requestedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements service discovery subnet scan schema.
 */
export const serviceDiscoverySubnetScanSchema = z
  .object({
    enabled: z.boolean().default(true),
    cidrs: z.array(ipv4CidrSchema).max(128).optional(),
    includeAutoLocalCidrs: z.boolean().default(false),
    includeCommonWebPorts: z.boolean().default(true),
    maxHosts: z.number().int().min(1).max(4096).optional(),
    concurrency: z.number().int().min(1).max(128).optional(),
    connectTimeoutMs: z.number().int().min(100).max(10_000).optional(),
    toolCallTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  })
  .strict();

/**
 * Implements service discovery config schema.
 */
export const serviceDiscoveryConfigSchema = z
  .object({
    enabled: z.boolean(),
    cidrs: z.array(ipv4CidrSchema).max(128),
    includeAutoLocalCidrs: z.boolean(),
    includeCommonWebPorts: z.boolean(),
    maxHosts: z.number().int().min(1).max(4096),
    concurrency: z.number().int().min(1).max(128),
    connectTimeoutMs: z.number().int().min(100).max(10_000),
    toolCallTimeoutMs: z.number().int().min(5_000).max(600_000),
  })
  .strict();

/**
 * Implements service discovery config response schema.
 */
export const serviceDiscoveryConfigResponseSchema = z
  .object({
    config: serviceDiscoveryConfigSchema,
    intervalSec: z.number().int().min(60),
    nextScheduledRunAt: z.string().datetime(),
    lastRunAt: z.string().datetime().nullable(),
    isRunning: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements service discovery config update schema.
 */
export const serviceDiscoveryConfigUpdateSchema = z
  .object({
    confirm: z.literal(true),
    config: serviceDiscoveryConfigSchema,
  })
  .strict();

/**
 * Implements service discovery run request schema.
 */
export const serviceDiscoveryRunRequestSchema = z
  .object({
    confirm: z.literal(true),
    hostId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Implements service discovery run delete schema.
 */
export const serviceDiscoveryRunDeleteSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements service discovery run status schema.
 */
export const serviceDiscoveryRunStatusSchema = z.enum(['COMPLETED', 'FAILED']);

/**
 * Implements service discovery run history status schema.
 */
export const serviceDiscoveryRunHistoryStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED']);

/**
 * Implements service discovery subnet summary schema.
 */
export const serviceDiscoverySubnetSummarySchema = z
  .object({
    scannerAgents: z.number().int().nonnegative(),
    cidrCount: z.number().int().nonnegative(),
    hostsScanned: z.number().int().nonnegative(),
    hostsReachable: z.number().int().nonnegative(),
    detections: z.number().int().nonnegative(),
    upserts: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict();

/**
 * Implements service discovery verification summary schema.
 */
export const serviceDiscoveryVerificationSummarySchema = z
  .object({
    hostsChecked: z.number().int().nonnegative(),
    hostsUp: z.number().int().nonnegative(),
    hostsDown: z.number().int().nonnegative(),
    hostsSkipped: z.number().int().nonnegative(),
    servicesChecked: z.number().int().nonnegative(),
    servicesUp: z.number().int().nonnegative(),
    servicesDown: z.number().int().nonnegative(),
    servicesSkipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Implements service discovery run response schema.
 */
export const serviceDiscoveryRunResponseSchema = z
  .object({
    runId: z.string().uuid(),
    status: serviceDiscoveryRunStatusSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    trigger: z.enum(['SCHEDULE', 'MANUAL']),
    summary: z
      .object({
        hostCount: z.number().int().nonnegative(),
        probeCount: z.number().int().nonnegative(),
        detectedCount: z.number().int().nonnegative(),
        upsertCount: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        verification: serviceDiscoveryVerificationSummarySchema.optional(),
        appliedConfig: z
          .object({
            subnetScan: serviceDiscoveryConfigSchema,
          })
          .strict()
          .optional(),
        subnet: serviceDiscoverySubnetSummarySchema.optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Implements service discovery run history item schema.
 */
export const serviceDiscoveryRunHistoryItemSchema = z
  .object({
    id: z.string().uuid(),
    trigger: z.enum(['SCHEDULE', 'MANUAL']),
    triggeredByUserId: z.string().uuid().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    status: serviceDiscoveryRunHistoryStatusSchema,
    hostCount: z.number().int().nonnegative(),
    probeCount: z.number().int().nonnegative(),
    detectedCount: z.number().int().nonnegative(),
    upsertCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    summary: z.unknown().nullable(),
  })
  .strict();

/**
 * Implements service discovery run history response schema.
 */
export const serviceDiscoveryRunHistoryResponseSchema = z
  .object({
    runs: z.array(serviceDiscoveryRunHistoryItemSchema),
  })
  .strict();

/**
 * Implements service discovery run delete response schema.
 */
export const serviceDiscoveryRunDeleteResponseSchema = z
  .object({
    ok: z.literal(true),
    deleted: z.literal(true),
    runId: z.string().uuid(),
  })
  .strict();

/**
 * Implements service discovery catalog response schema.
 */
export const serviceDiscoveryCatalogResponseSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(['BUILTIN', 'HYBRID']),
    expiresAt: z.string().datetime(),
    lastError: z.string().nullable(),
    serviceCount: z.number().int().nonnegative(),
    services: z.array(
      z
        .object({
          id: z.string().min(1).max(64),
          name: z.string().min(1).max(120),
          aliases: z.array(z.string().min(1).max(80)),
          systemdHints: z.array(z.string().min(1).max(80)),
          containerHints: z.array(z.string().min(1).max(120)),
          processHints: z.array(z.string().min(1).max(120)),
          tags: z.array(z.string().min(1).max(40)),
          probes: z.array(
            z
              .object({
                protocol: z.enum(['http', 'https', 'tcp']),
                ports: z.array(z.number().int().min(1).max(65535)).min(1).max(20),
                path: z.string().max(256).optional(),
                statusCodes: z.array(z.number().int().min(100).max(599)).max(10).optional(),
                bodyContains: z.array(z.string().min(1).max(120)).max(12).optional(),
                headersContain: z.array(z.string().min(1).max(120)).max(12).optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Implements dashboard agent severity schema.
 */
export const dashboardAgentSeveritySchema = z.enum(['info', 'warn', 'critical']);
/**
 * Implements dashboard agent category schema.
 */
export const dashboardAgentCategorySchema = z.enum([
  'monitor',
  'host',
  'service-discovery',
  'event',
  'ai-activity',
  'system',
]);

/**
 * Implements dashboard agent highlight schema.
 */
export const dashboardAgentHighlightSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(1200),
    severity: dashboardAgentSeveritySchema,
    category: dashboardAgentCategorySchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string().min(1).max(240)).max(12).default([]),
    investigation: z.array(z.string().min(1).max(240)).max(12).default([]),
    recommendedActions: z.array(z.string().min(1).max(240)).max(8).default([]),
    references: z
      .object({
        hostId: z.string().uuid().optional(),
        monitorId: z.string().uuid().optional(),
        discoveryRunId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    eventEmitted: z.boolean().optional(),
  })
  .strict();

/**
 * Implements dashboard agent tool call schema.
 */
export const dashboardAgentToolCallSchema = z
  .object({
    tool: z.string().min(1).max(120),
    ok: z.boolean(),
    details: z.string().max(240).optional(),
  })
  .strict();

/**
 * Implements dashboard agent open ai call status schema.
 */
export const dashboardAgentOpenAiCallStatusSchema = z.enum([
  'completed',
  'invalid_output',
  'failed',
]);

/**
 * Implements dashboard agent open ai usage schema.
 */
export const dashboardAgentOpenAiUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * Implements dashboard agent open ai call schema.
 */
export const dashboardAgentOpenAiCallSchema = z
  .object({
    id: z.string().min(1).max(80),
    step: z.string().min(1).max(80),
    model: z.string().min(1).max(120),
    status: dashboardAgentOpenAiCallStatusSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    requestPayload: z.unknown().nullable(),
    responsePayload: z.unknown().nullable(),
    outputText: z.string().nullable(),
    reasoningSummary: z.array(z.string().min(1).max(1200)).max(20).default([]),
    usage: dashboardAgentOpenAiUsageSchema.nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();

/**
 * Implements dashboard agent run summary schema.
 */
export const dashboardAgentRunSummarySchema = z
  .object({
    analyzedAt: z.string().datetime(),
    context: z
      .object({
        hosts: z.number().int().nonnegative(),
        monitors: z.number().int().nonnegative(),
        services: z.number().int().nonnegative(),
        activeAlerts: z.number().int().nonnegative(),
        discoveryRunsReviewed: z.number().int().nonnegative(),
        aiQuestionsReviewed: z.number().int().nonnegative(),
        eventsReviewed: z.number().int().nonnegative(),
      })
      .strict(),
    notes: z.array(z.string().min(1).max(240)).max(40).default([]),
    toolCalls: z.array(dashboardAgentToolCallSchema).max(120).default([]),
    openAiCalls: z.array(dashboardAgentOpenAiCallSchema).max(40).default([]),
  })
  .strict();

/**
 * Implements dashboard agent run trigger schema.
 */
export const dashboardAgentRunTriggerSchema = z.enum(['SCHEDULE', 'MANUAL']);
/**
 * Implements dashboard agent run status schema.
 */
export const dashboardAgentRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED']);

/**
 * Implements dashboard agent run history item schema.
 */
export const dashboardAgentRunHistoryItemSchema = z
  .object({
    id: z.string().uuid(),
    trigger: dashboardAgentRunTriggerSchema,
    triggeredByUserId: z.string().uuid().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    status: dashboardAgentRunStatusSchema,
    findingCount: z.number().int().nonnegative(),
    highPriorityCount: z.number().int().nonnegative(),
    highlights: z.array(dashboardAgentHighlightSchema).max(20).nullable(),
    error: z.string().nullable(),
    summary: z.unknown().nullable(),
  })
  .strict();

/**
 * Implements dashboard agent runs response schema.
 */
export const dashboardAgentRunsResponseSchema = z
  .object({
    runs: z.array(dashboardAgentRunHistoryItemSchema),
  })
  .strict();

/**
 * Implements dashboard agent run detail response schema.
 */
export const dashboardAgentRunDetailResponseSchema = z
  .object({
    run: dashboardAgentRunHistoryItemSchema,
  })
  .strict();

/**
 * Implements dashboard agent config schema.
 */
export const dashboardAgentConfigSchema = z
  .object({
    enabled: z.boolean(),
    intervalSec: z.number().int().min(60).max(86_400),
    escalateCreateEvents: z.boolean(),
    personality: z.string().max(6000),
  })
  .strict();

/**
 * Implements dashboard agent config update schema.
 */
export const dashboardAgentConfigUpdateSchema = z
  .object({
    confirm: z.literal(true),
    config: dashboardAgentConfigSchema,
  })
  .strict();

/**
 * Implements dashboard agent config response schema.
 */
export const dashboardAgentConfigResponseSchema = z
  .object({
    config: dashboardAgentConfigSchema,
    defaultPersonality: z.string(),
    nextScheduledRunAt: z.string().datetime().nullable(),
    lastRunAt: z.string().datetime().nullable(),
    isRunning: z.boolean(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/**
 * Implements dashboard agent status response schema.
 */
export const dashboardAgentStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    intervalSec: z.number().int().min(60).max(86_400),
    isRunning: z.boolean(),
    nextScheduledRunAt: z.string().datetime().nullable(),
    lastRunAt: z.string().datetime().nullable(),
    lastRunId: z.string().uuid().nullable(),
    lastRunStatus: dashboardAgentRunStatusSchema.nullable(),
  })
  .strict();

/**
 * Implements dashboard agent run request schema.
 */
export const dashboardAgentRunRequestSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements dashboard agent run delete schema.
 */
export const dashboardAgentRunDeleteSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements dashboard agent run delete response schema.
 */
export const dashboardAgentRunDeleteResponseSchema = z
  .object({
    ok: z.literal(true),
    deleted: z.literal(true),
    runId: z.string().uuid(),
  })
  .strict();

/**
 * Implements dashboard agent highlights response schema.
 */
export const dashboardAgentHighlightsResponseSchema = z
  .object({
    runId: z.string().uuid().nullable(),
    status: dashboardAgentRunStatusSchema.nullable(),
    generatedAt: z.string().datetime().nullable(),
    highlights: z.array(dashboardAgentHighlightSchema).max(20),
  })
  .strict();

/**
 * Implements pagination schema.
 */
export const paginationSchema = z.object({
  limit: z.number().int().positive().max(500).default(100),
});

/**
 * Describes the login request shape.
 */
export type LoginRequest = z.infer<typeof loginRequestSchema>;
/**
 * Describes the login response shape.
 */
export type LoginResponse = z.infer<typeof loginResponseSchema>;
/**
 * Describes the auth setup status shape.
 */
export type AuthSetupStatus = z.infer<typeof authSetupStatusSchema>;
/**
 * Describes the auth setup request shape.
 */
export type AuthSetupRequest = z.infer<typeof authSetupRequestSchema>;
/**
 * Describes the auth change password shape.
 */
export type AuthChangePassword = z.infer<typeof authChangePasswordSchema>;
/**
 * Describes the user shape.
 */
export type User = z.infer<typeof userSchema>;
/**
 * Describes the host summary shape.
 */
export type HostSummary = z.infer<typeof hostSummarySchema>;
/**
 * Describes the host type shape.
 */
export type HostType = z.infer<typeof hostTypeSchema>;
/**
 * Describes the host metadata update shape.
 */
export type HostMetadataUpdate = z.infer<typeof hostMetadataUpdateSchema>;
/**
 * Describes the host metadata response shape.
 */
export type HostMetadataResponse = z.infer<typeof hostMetadataResponseSchema>;
/**
 * Describes the create check shape.
 */
export type CreateCheck = z.infer<typeof createCheckSchema>;
/**
 * Describes the alert scope entity shape.
 */
export type AlertScopeEntity = z.infer<typeof alertScopeEntitySchema>;
/**
 * Describes the alert condition match shape.
 */
export type AlertConditionMatch = z.infer<typeof alertConditionMatchSchema>;
/**
 * Describes the alert comparator shape.
 */
export type AlertComparator = z.infer<typeof alertComparatorSchema>;
/**
 * Describes the alert reducer shape.
 */
export type AlertReducer = z.infer<typeof alertReducerSchema>;
/**
 * Describes the alert severity shape.
 */
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;
/**
 * Describes the alert no data behavior shape.
 */
export type AlertNoDataBehavior = z.infer<typeof alertNoDataBehaviorSchema>;
/**
 * Describes the alert host metric shape.
 */
export type AlertHostMetric = z.infer<typeof alertHostMetricSchema>;
/**
 * Describes the alert homelab metric shape.
 */
export type AlertHomelabMetric = z.infer<typeof alertHomelabMetricSchema>;
/**
 * Describes the alert check mode shape.
 */
export type AlertCheckMode = z.infer<typeof alertCheckModeSchema>;
/**
 * Describes the alert state target shape.
 */
export type AlertStateTarget = z.infer<typeof alertStateTargetSchema>;
/**
 * Describes the alert incident state shape.
 */
export type AlertIncidentState = z.infer<typeof alertIncidentStateSchema>;
/**
 * Describes the alert scope shape.
 */
export type AlertScope = z.infer<typeof alertScopeSchema>;
/**
 * Describes the alert condition shape.
 */
export type AlertCondition = z.infer<typeof alertConditionSchema>;
/**
 * Describes the alert condition group shape.
 */
export type AlertConditionGroup = z.infer<typeof alertConditionGroupSchema>;
/**
 * Describes the alert evaluation shape.
 */
export type AlertEvaluation = z.infer<typeof alertEvaluationSchema>;
/**
 * Describes the alert delivery shape.
 */
export type AlertDelivery = z.infer<typeof alertDeliverySchema>;
/**
 * Describes the alert rule spec shape.
 */
export type AlertRuleSpec = z.infer<typeof alertRuleSpecSchema>;
/**
 * Describes the alert rule draft shape.
 */
export type AlertRuleDraft = z.infer<typeof alertRuleDraftSchema>;
/**
 * Describes the alert rule create shape.
 */
export type AlertRuleCreate = z.infer<typeof alertRuleCreateSchema>;
/**
 * Describes the alert rule update shape.
 */
export type AlertRuleUpdate = z.infer<typeof alertRuleUpdateSchema>;
/**
 * Describes the alert rule delete shape.
 */
export type AlertRuleDelete = z.infer<typeof alertRuleDeleteSchema>;
/**
 * Describes the alert incident acknowledge shape.
 */
export type AlertIncidentAcknowledge = z.infer<typeof alertIncidentAcknowledgeSchema>;
/**
 * Describes the alert parse request shape.
 */
export type AlertParseRequest = z.infer<typeof alertParseRequestSchema>;
/**
 * Describes the alert preview request shape.
 */
export type AlertPreviewRequest = z.infer<typeof alertPreviewRequestSchema>;
/**
 * Describes the alert catalog response shape.
 */
export type AlertCatalogResponse = z.infer<typeof alertCatalogResponseSchema>;
/**
 * Describes the alert parse response shape.
 */
export type AlertParseResponse = z.infer<typeof alertParseResponseSchema>;
/**
 * Describes the alert preview response shape.
 */
export type AlertPreviewResponse = z.infer<typeof alertPreviewResponseSchema>;
/**
 * Describes the alert rule summary shape.
 */
export type AlertRuleSummary = z.infer<typeof alertRuleSummarySchema>;
/**
 * Describes the alert incident shape.
 */
export type AlertIncident = z.infer<typeof alertIncidentSchema>;
/**
 * Describes the alert rules response shape.
 */
export type AlertRulesResponse = z.infer<typeof alertRulesResponseSchema>;
/**
 * Describes the alert incidents response shape.
 */
export type AlertIncidentsResponse = z.infer<typeof alertIncidentsResponseSchema>;
/**
 * Describes the alert silence create shape.
 */
export type AlertSilenceCreate = z.infer<typeof alertSilenceCreateSchema>;
/**
 * Describes the integration shape.
 */
export type Integration = z.infer<typeof integrationSchema>;
/**
 * Describes the integration upsert shape.
 */
export type IntegrationUpsert = z.infer<typeof integrationUpsertSchema>;
/**
 * Describes the integration action request shape.
 */
export type IntegrationActionRequest = z.infer<typeof integrationActionRequestSchema>;
/**
 * Describes the integration delete shape.
 */
export type IntegrationDelete = z.infer<typeof integrationDeleteSchema>;
/**
 * Describes the integration test response shape.
 */
export type IntegrationTestResponse = z.infer<typeof integrationTestResponseSchema>;
/**
 * Describes the integration sync response shape.
 */
export type IntegrationSyncResponse = z.infer<typeof integrationSyncResponseSchema>;
/**
 * Describes the integration delete response shape.
 */
export type IntegrationDeleteResponse = z.infer<typeof integrationDeleteResponseSchema>;
/**
 * Describes the proxmox guest kind shape.
 */
export type ProxmoxGuestKind = z.infer<typeof proxmoxGuestKindSchema>;
/**
 * Describes the proxmox guest action shape.
 */
export type ProxmoxGuestAction = z.infer<typeof proxmoxGuestActionSchema>;
/**
 * Describes the proxmox guest summary shape.
 */
export type ProxmoxGuestSummary = z.infer<typeof proxmoxGuestSummarySchema>;
/**
 * Describes the proxmox guest inventory response shape.
 */
export type ProxmoxGuestInventoryResponse = z.infer<typeof proxmoxGuestInventoryResponseSchema>;
/**
 * Describes the proxmox guest detail shape.
 */
export type ProxmoxGuestDetail = z.infer<typeof proxmoxGuestDetailSchema>;
/**
 * Describes the proxmox task summary shape.
 */
export type ProxmoxTaskSummary = z.infer<typeof proxmoxTaskSummarySchema>;
/**
 * Describes the proxmox task list response shape.
 */
export type ProxmoxTaskListResponse = z.infer<typeof proxmoxTaskListResponseSchema>;
/**
 * Describes the proxmox guest action request shape.
 */
export type ProxmoxGuestActionRequest = z.infer<typeof proxmoxGuestActionRequestSchema>;
/**
 * Describes the proxmox guest action response shape.
 */
export type ProxmoxGuestActionResponse = z.infer<typeof proxmoxGuestActionResponseSchema>;
/**
 * Describes the create tool proposal shape.
 */
export type CreateToolProposal = z.infer<typeof createToolProposalSchema>;
/**
 * Describes the agent install action shape.
 */
export type AgentInstallAction = z.infer<typeof agentInstallActionSchema>;
/**
 * Describes the agent install status shape.
 */
export type AgentInstallStatus = z.infer<typeof agentInstallStatusSchema>;
/**
 * Describes the agent install auth mode shape.
 */
export type AgentInstallAuthMode = z.infer<typeof agentInstallAuthModeSchema>;
/**
 * Describes the create agent install request shape.
 */
export type CreateAgentInstallRequest = z.infer<typeof createAgentInstallRequestSchema>;
/**
 * Describes the agent install approve shape.
 */
export type AgentInstallApprove = z.infer<typeof agentInstallApproveSchema>;
/**
 * Describes the agent install uninstall from agent shape.
 */
export type AgentInstallUninstallFromAgent = z.infer<typeof agentInstallUninstallFromAgentSchema>;
/**
 * Describes the agent install deny shape.
 */
export type AgentInstallDeny = z.infer<typeof agentInstallDenySchema>;
/**
 * Describes the launch agent install request shape.
 */
export type LaunchAgentInstallRequest = z.infer<typeof launchAgentInstallRequestSchema>;
/**
 * Describes the agent install request log shape.
 */
export type AgentInstallRequestLog = z.infer<typeof agentInstallRequestLogSchema>;
/**
 * Describes the agent install request shape.
 */
export type AgentInstallRequest = z.infer<typeof agentInstallRequestSchema>;
/**
 * Describes the agent install list response shape.
 */
export type AgentInstallListResponse = z.infer<typeof agentInstallListResponseSchema>;
/**
 * Describes the agent install binary manifest item shape.
 */
export type AgentInstallBinaryManifestItem = z.infer<typeof agentInstallBinaryManifestItemSchema>;
/**
 * Describes the agent install binary manifest response shape.
 */
export type AgentInstallBinaryManifestResponse = z.infer<
  typeof agentInstallBinaryManifestResponseSchema
>;
/**
 * Describes the agent recovery claim status shape.
 */
export type AgentRecoveryClaimStatus = z.infer<typeof agentRecoveryClaimStatusSchema>;
/**
 * Describes the agent recovery claim shape.
 */
export type AgentRecoveryClaim = z.infer<typeof agentRecoveryClaimSchema>;
/**
 * Describes the agent recovery summary preview item shape.
 */
export type AgentRecoverySummaryPreviewItem = z.infer<typeof agentRecoverySummaryPreviewItemSchema>;
/**
 * Describes the agent recovery summary response shape.
 */
export type AgentRecoverySummaryResponse = z.infer<typeof agentRecoverySummaryResponseSchema>;
/**
 * Describes the agent recovery claim approve shape.
 */
export type AgentRecoveryClaimApprove = z.infer<typeof agentRecoveryClaimApproveSchema>;
/**
 * Describes the agent recovery claim deny shape.
 */
export type AgentRecoveryClaimDeny = z.infer<typeof agentRecoveryClaimDenySchema>;
/**
 * Describes the ai chat request shape.
 */
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
/**
 * Describes the mcp tool call shape.
 */
export type McpToolCall = z.infer<typeof mcpToolCallSchema>;
/**
 * Describes the monitor parse request shape.
 */
export type MonitorParseRequest = z.infer<typeof monitorParseRequestSchema>;
/**
 * Describes the terminal execute request shape.
 */
export type TerminalExecuteRequest = z.infer<typeof terminalExecuteRequestSchema>;
/**
 * Describes the terminal ssh session create request shape.
 */
export type TerminalSshSessionCreateRequest = z.infer<typeof terminalSshSessionCreateRequestSchema>;
/**
 * Describes the terminal ssh session input request shape.
 */
export type TerminalSshSessionInputRequest = z.infer<typeof terminalSshSessionInputRequestSchema>;
/**
 * Describes the terminal ssh socket client message shape.
 */
export type TerminalSshSocketClientMessage = z.infer<typeof terminalSshSocketClientMessageSchema>;
/**
 * Describes the terminal ssh socket server message shape.
 */
export type TerminalSshSocketServerMessage = z.infer<typeof terminalSshSocketServerMessageSchema>;
/**
 * Describes the tool proposal approve shape.
 */
export type ToolProposalApprove = z.infer<typeof toolProposalApproveSchema>;
/**
 * Describes the tool proposal deny shape.
 */
export type ToolProposalDeny = z.infer<typeof toolProposalDenySchema>;
/**
 * Describes the ai conversation retention shape.
 */
export type AiConversationRetention = z.infer<typeof aiConversationRetentionSchema>;
/**
 * Describes the ai personality update shape.
 */
export type AiPersonalityUpdate = z.infer<typeof aiPersonalityUpdateSchema>;
/**
 * Describes the ai personality shape.
 */
export type AiPersonality = z.infer<typeof aiPersonalitySchema>;
/**
 * Describes the ai provider config update shape.
 */
export type AiProviderConfigUpdate = z.infer<typeof aiProviderConfigUpdateSchema>;
/**
 * Describes the ai provider config response shape.
 */
export type AiProviderConfigResponse = z.infer<typeof aiProviderConfigResponseSchema>;
/**
 * Describes the notification route type shape.
 */
export type NotificationRouteType = z.infer<typeof notificationRouteTypeSchema>;
/**
 * Describes the notification route create shape.
 */
export type NotificationRouteCreate = z.infer<typeof notificationRouteCreateSchema>;
/**
 * Describes the ui theme preset shape.
 */
export type UiThemePreset = z.infer<typeof uiThemePresetSchema>;
/**
 * Describes the ui theme mode shape.
 */
export type UiThemeMode = z.infer<typeof uiThemeModeSchema>;
/**
 * Describes the ui theme palette shape.
 */
export type UiThemePalette = z.infer<typeof uiThemePaletteSchema>;
/**
 * Describes the ui theme style shape.
 */
export type UiThemeStyle = z.infer<typeof uiThemeStyleSchema>;
/**
 * Describes the ui theme settings shape.
 */
export type UiThemeSettings = z.infer<typeof uiThemeSettingsSchema>;
/**
 * Describes the ui theme settings update shape.
 */
export type UiThemeSettingsUpdate = z.infer<typeof uiThemeSettingsUpdateSchema>;
/**
 * Describes the ui theme settings response shape.
 */
export type UiThemeSettingsResponse = z.infer<typeof uiThemeSettingsResponseSchema>;
/**
 * Describes the host list column id shape.
 */
export type HostListColumnId = z.infer<typeof hostListColumnIdSchema>;
/**
 * Describes the host list hideable column id shape.
 */
export type HostListHideableColumnId = z.infer<typeof hostListHideableColumnIdSchema>;
/**
 * Describes the host list columns preferences shape.
 */
export type HostListColumnsPreferences = z.infer<typeof hostListColumnsPreferencesSchema>;
/**
 * Describes the dashboard suggestions notice shape.
 */
export type DashboardSuggestionsNotice = z.infer<typeof dashboardSuggestionsNoticeSchema>;
/**
 * Describes the dashboard orphan recovery notice shape.
 */
export type DashboardOrphanRecoveryNotice = z.infer<typeof dashboardOrphanRecoveryNoticeSchema>;
/**
 * Describes the sidebar nav item id shape.
 */
export type SidebarNavItemId = z.infer<typeof sidebarNavItemIdSchema>;
/**
 * Describes the sidebar navigation preferences shape.
 */
export type SidebarNavigationPreferences = z.infer<typeof sidebarNavigationPreferencesSchema>;
/**
 * Describes the user preferences shape.
 */
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
/**
 * Describes the user preferences response shape.
 */
export type UserPreferencesResponse = z.infer<typeof userPreferencesResponseSchema>;
/**
 * Describes the hidden hosts update shape.
 */
export type HiddenHostsUpdate = z.infer<typeof hiddenHostsUpdateSchema>;
/**
 * Describes the discovery subnets update shape.
 */
export type DiscoverySubnetsUpdate = z.infer<typeof discoverySubnetsUpdateSchema>;
/**
 * Describes the host list columns update shape.
 */
export type HostListColumnsUpdate = z.infer<typeof hostListColumnsUpdateSchema>;
/**
 * Describes the dashboard suggestions notice update shape.
 */
export type DashboardSuggestionsNoticeUpdate = z.infer<
  typeof dashboardSuggestionsNoticeUpdateSchema
>;
/**
 * Describes the dashboard orphan recovery notice update shape.
 */
export type DashboardOrphanRecoveryNoticeUpdate = z.infer<
  typeof dashboardOrphanRecoveryNoticeUpdateSchema
>;
/**
 * Describes the sidebar navigation update shape.
 */
export type SidebarNavigationUpdate = z.infer<typeof sidebarNavigationUpdateSchema>;
/**
 * Describes the host telemetry config shape.
 */
export type HostTelemetryConfig = z.infer<typeof hostTelemetryConfigSchema>;
/**
 * Describes the host telemetry config response shape.
 */
export type HostTelemetryConfigResponse = z.infer<typeof hostTelemetryConfigResponseSchema>;
/**
 * Describes the host telemetry config update shape.
 */
export type HostTelemetryConfigUpdate = z.infer<typeof hostTelemetryConfigUpdateSchema>;
/**
 * Describes the host telemetry refresh request shape.
 */
export type HostTelemetryRefreshRequest = z.infer<typeof hostTelemetryRefreshRequestSchema>;
/**
 * Describes the host telemetry refresh response shape.
 */
export type HostTelemetryRefreshResponse = z.infer<typeof hostTelemetryRefreshResponseSchema>;
/**
 * Describes the service discovery run request shape.
 */
export type ServiceDiscoveryRunRequest = z.infer<typeof serviceDiscoveryRunRequestSchema>;
/**
 * Describes the service discovery run delete shape.
 */
export type ServiceDiscoveryRunDelete = z.infer<typeof serviceDiscoveryRunDeleteSchema>;
/**
 * Describes the service discovery subnet scan shape.
 */
export type ServiceDiscoverySubnetScan = z.infer<typeof serviceDiscoverySubnetScanSchema>;
/**
 * Describes the service discovery config shape.
 */
export type ServiceDiscoveryConfig = z.infer<typeof serviceDiscoveryConfigSchema>;
/**
 * Describes the service discovery config response shape.
 */
export type ServiceDiscoveryConfigResponse = z.infer<typeof serviceDiscoveryConfigResponseSchema>;
/**
 * Describes the service discovery config update shape.
 */
export type ServiceDiscoveryConfigUpdate = z.infer<typeof serviceDiscoveryConfigUpdateSchema>;
/**
 * Describes the service discovery subnet summary shape.
 */
export type ServiceDiscoverySubnetSummary = z.infer<typeof serviceDiscoverySubnetSummarySchema>;
/**
 * Describes the service discovery verification summary shape.
 */
export type ServiceDiscoveryVerificationSummary = z.infer<
  typeof serviceDiscoveryVerificationSummarySchema
>;
/**
 * Describes the service discovery run status shape.
 */
export type ServiceDiscoveryRunStatus = z.infer<typeof serviceDiscoveryRunStatusSchema>;
/**
 * Describes the service discovery run history status shape.
 */
export type ServiceDiscoveryRunHistoryStatus = z.infer<
  typeof serviceDiscoveryRunHistoryStatusSchema
>;
/**
 * Describes the service discovery run response shape.
 */
export type ServiceDiscoveryRunResponse = z.infer<typeof serviceDiscoveryRunResponseSchema>;
/**
 * Describes the service discovery run history item shape.
 */
export type ServiceDiscoveryRunHistoryItem = z.infer<typeof serviceDiscoveryRunHistoryItemSchema>;
/**
 * Describes the service discovery run history response shape.
 */
export type ServiceDiscoveryRunHistoryResponse = z.infer<
  typeof serviceDiscoveryRunHistoryResponseSchema
>;
/**
 * Describes the service discovery run delete response shape.
 */
export type ServiceDiscoveryRunDeleteResponse = z.infer<
  typeof serviceDiscoveryRunDeleteResponseSchema
>;
/**
 * Describes the service discovery catalog response shape.
 */
export type ServiceDiscoveryCatalogResponse = z.infer<typeof serviceDiscoveryCatalogResponseSchema>;
/**
 * Describes the dashboard agent severity shape.
 */
export type DashboardAgentSeverity = z.infer<typeof dashboardAgentSeveritySchema>;
/**
 * Describes the dashboard agent category shape.
 */
export type DashboardAgentCategory = z.infer<typeof dashboardAgentCategorySchema>;
/**
 * Describes the dashboard agent highlight shape.
 */
export type DashboardAgentHighlight = z.infer<typeof dashboardAgentHighlightSchema>;
/**
 * Describes the dashboard agent tool call shape.
 */
export type DashboardAgentToolCall = z.infer<typeof dashboardAgentToolCallSchema>;
/**
 * Describes the dashboard agent open ai call status shape.
 */
export type DashboardAgentOpenAiCallStatus = z.infer<typeof dashboardAgentOpenAiCallStatusSchema>;
/**
 * Describes the dashboard agent open ai usage shape.
 */
export type DashboardAgentOpenAiUsage = z.infer<typeof dashboardAgentOpenAiUsageSchema>;
/**
 * Describes the dashboard agent open ai call shape.
 */
export type DashboardAgentOpenAiCall = z.infer<typeof dashboardAgentOpenAiCallSchema>;
/**
 * Describes the dashboard agent run summary shape.
 */
export type DashboardAgentRunSummary = z.infer<typeof dashboardAgentRunSummarySchema>;
/**
 * Describes the dashboard agent run trigger shape.
 */
export type DashboardAgentRunTrigger = z.infer<typeof dashboardAgentRunTriggerSchema>;
/**
 * Describes the dashboard agent run status shape.
 */
export type DashboardAgentRunStatus = z.infer<typeof dashboardAgentRunStatusSchema>;
/**
 * Describes the dashboard agent run history item shape.
 */
export type DashboardAgentRunHistoryItem = z.infer<typeof dashboardAgentRunHistoryItemSchema>;
/**
 * Describes the dashboard agent runs response shape.
 */
export type DashboardAgentRunsResponse = z.infer<typeof dashboardAgentRunsResponseSchema>;
/**
 * Describes the dashboard agent run detail response shape.
 */
export type DashboardAgentRunDetailResponse = z.infer<typeof dashboardAgentRunDetailResponseSchema>;
/**
 * Describes the dashboard agent config shape.
 */
export type DashboardAgentConfig = z.infer<typeof dashboardAgentConfigSchema>;
/**
 * Describes the dashboard agent config update shape.
 */
export type DashboardAgentConfigUpdate = z.infer<typeof dashboardAgentConfigUpdateSchema>;
/**
 * Describes the dashboard agent config response shape.
 */
export type DashboardAgentConfigResponse = z.infer<typeof dashboardAgentConfigResponseSchema>;
/**
 * Describes the dashboard agent status response shape.
 */
export type DashboardAgentStatusResponse = z.infer<typeof dashboardAgentStatusResponseSchema>;
/**
 * Describes the dashboard agent run request shape.
 */
export type DashboardAgentRunRequest = z.infer<typeof dashboardAgentRunRequestSchema>;
/**
 * Describes the dashboard agent run delete shape.
 */
export type DashboardAgentRunDelete = z.infer<typeof dashboardAgentRunDeleteSchema>;
/**
 * Describes the dashboard agent run delete response shape.
 */
export type DashboardAgentRunDeleteResponse = z.infer<typeof dashboardAgentRunDeleteResponseSchema>;
/**
 * Describes the dashboard agent highlights response shape.
 */
export type DashboardAgentHighlightsResponse = z.infer<
  typeof dashboardAgentHighlightsResponseSchema
>;
/**
 * Describes the health status shape.
 */
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the setup behavior.
 */
import { vi } from 'vitest';

/**
 * Exercises the string enum scenario covered by this test helper.
 */
function stringEnum<const T extends readonly string[]>(values: T) {
  return Object.freeze(
    Object.fromEntries(values.map((value) => [value, value])) as { [K in T[number]]: K },
  );
}

class PrismaClient {
  async $connect() {
    return undefined;
  }

  async $disconnect() {
    return undefined;
  }

  async $transaction() {
    return undefined;
  }
}

vi.mock('@prisma/client', () => ({
  PrismaClient,
  Prisma: {
    TransactionIsolationLevel: {
      ReadCommitted: 'ReadCommitted',
    },
  },
  AgentStatus: stringEnum(['ONLINE', 'OFFLINE', 'REVOKED']),
  AiMessageRole: stringEnum(['USER', 'ASSISTANT', 'TOOL', 'SYSTEM']),
  AlertEventStatus: stringEnum(['PENDING', 'FIRING', 'RESOLVED']),
  AlertRuleType: stringEnum([
    'CHECK_DOWN_CONSECUTIVE',
    'HOST_OFFLINE',
    'DISK_USAGE_GT',
    'RULE_ENGINE',
  ]),
  CheckResultStatus: stringEnum(['UP', 'DOWN', 'WARN', 'UNKNOWN']),
  CheckType: stringEnum(['HTTP', 'TCP', 'ICMP']),
  EventSeverity: stringEnum(['INFO', 'WARN', 'ERROR']),
  HealthStatus: stringEnum(['OK', 'WARN', 'CRIT', 'UNKNOWN']),
  IntegrationType: stringEnum(['PROXMOX']),
  NotificationType: stringEnum(['WEBHOOK', 'DISCORD']),
  RecoveryKeyAlg: stringEnum(['ED25519']),
  SilenceTargetType: stringEnum(['ALERT_RULE', 'HOST', 'SERVICE', 'CHECK']),
  ToolProposalStatus: stringEnum(['PENDING', 'APPROVED', 'DENIED', 'EXECUTED', 'FAILED']),
}));

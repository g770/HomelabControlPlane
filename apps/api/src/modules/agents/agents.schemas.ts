/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines the agents schemas validation and transport schemas.
 */
import { z } from 'zod';
import { recoveryKeyAlgSchema } from '../agent-recovery/agent-recovery.schemas';

/**
 * Creates enrollment token schema.
 */
export const createEnrollmentTokenSchema = z.object({
  expiresHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
});

const recoveryRegistrationFields = {
  recoveryKeyAlg: recoveryKeyAlgSchema.optional(),
  recoveryPublicKey: z.string().min(32).max(4096).optional(),
};

/**
 * Implements enroll schema.
 */
export const enrollSchema = z
  .object({
    enrollmentToken: z.string().min(16),
    endpoint: z.string().url(),
    mcpEndpoint: z.string().url(),
    displayName: z.string().optional(),
    hostname: z.string().min(1),
    tags: z.array(z.string()).default([]),
    agentVersion: z.string().optional(),
    ...recoveryRegistrationFields,
  })
  .superRefine((value, ctx) => {
    if (
      (value.recoveryKeyAlg && !value.recoveryPublicKey) ||
      (!value.recoveryKeyAlg && value.recoveryPublicKey)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recoveryKeyAlg and recoveryPublicKey must be provided together',
        path: ['recoveryPublicKey'],
      });
    }
  });

/**
 * Implements heartbeat schema.
 */
export const heartbeatSchema = z
  .object({
    status: z.enum(['ONLINE', 'OFFLINE']).default('ONLINE'),
    capabilities: z.record(z.unknown()).optional(),
    version: z.string().optional(),
    recoveryCertificateMissing: z.boolean().optional(),
    ...recoveryRegistrationFields,
  })
  .superRefine((value, ctx) => {
    if (
      (value.recoveryKeyAlg && !value.recoveryPublicKey) ||
      (!value.recoveryKeyAlg && value.recoveryPublicKey)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recoveryKeyAlg and recoveryPublicKey must be provided together',
        path: ['recoveryPublicKey'],
      });
    }
  });

/**
 * Implements facts schema.
 */
export const factsSchema = z.object({
  hostname: z.string().min(1),
  tags: z.array(z.string()).default([]),
  cpuPct: z.number().min(0).max(100),
  memPct: z.number().min(0).max(100),
  diskPct: z.number().min(0).max(100),
  snapshot: z.record(z.unknown()),
  agentVersion: z.string().optional(),
});

/**
 * Implements inventory schema.
 */
export const inventorySchema = z.object({
  hostname: z.string().min(1),
  services: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['OK', 'WARN', 'CRIT', 'UNKNOWN']).default('UNKNOWN'),
        endpoint: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  containers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        image: z.string(),
        status: z.string(),
      }),
    )
    .default([]),
  systemd: z
    .object({
      failedCount: z.number().int().nonnegative().default(0),
      units: z.array(z.object({ name: z.string(), state: z.string() })).default([]),
    })
    .default({ failedCount: 0, units: [] }),
  network: z.record(z.unknown()).optional(),
  storage: z.record(z.unknown()).optional(),
});

/**
 * Implements agent events schema.
 */
export const agentEventsSchema = z.object({
  events: z.array(
    z.object({
      type: z.string().min(1),
      message: z.string().min(1),
      severity: z.enum(['INFO', 'WARN', 'ERROR']).default('INFO'),
      payload: z.record(z.unknown()).optional(),
    }),
  ),
});

/**
 * Implements delete agent schema.
 */
export const deleteAgentSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

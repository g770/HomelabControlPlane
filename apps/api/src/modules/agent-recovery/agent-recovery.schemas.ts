/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines the agent recovery schemas validation and transport schemas.
 */
import { z } from 'zod';

/**
 * Implements recovery key alg schema.
 */
export const recoveryKeyAlgSchema = z.enum(['ED25519']);

/**
 * Implements agent recovery claim status schema.
 */
export const agentRecoveryClaimStatusSchema = z.enum([
  'PENDING_APPROVAL',
  'APPROVED_PENDING_AGENT',
  'DENIED',
  'COMPLETED',
]);

/**
 * Creates agent recovery challenge schema.
 */
export const createAgentRecoveryChallengeSchema = z.object({}).strict();

/**
 * Implements submit agent recovery claim schema.
 */
export const submitAgentRecoveryClaimSchema = z
  .object({
    challengeToken: z.string().min(20),
    recoveryCertificate: z.string().min(20),
    signature: z.string().min(16),
    hostname: z.string().min(1).max(255),
    primaryIp: z.string().max(255).optional(),
    displayName: z.string().max(255).optional(),
    endpoint: z.string().url(),
    mcpEndpoint: z.string().url(),
    agentVersion: z.string().max(128).optional(),
    tags: z.array(z.string().max(64)).max(32).default([]),
  })
  .strict();

/**
 * Implements agent recovery claim poll schema.
 */
export const agentRecoveryClaimPollSchema = z
  .object({
    pollToken: z.string().min(20),
  })
  .strict();

/**
 * Implements approve agent recovery claim schema.
 */
export const approveAgentRecoveryClaimSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

/**
 * Implements deny agent recovery claim schema.
 */
export const denyAgentRecoveryClaimSchema = z
  .object({
    confirm: z.literal(true),
    reason: z.string().min(1).max(500),
  })
  .strict();

/**
 * Describes the submit agent recovery claim shape.
 */
export type SubmitAgentRecoveryClaim = z.infer<typeof submitAgentRecoveryClaimSchema>;
/**
 * Describes the agent recovery claim poll shape.
 */
export type AgentRecoveryClaimPoll = z.infer<typeof agentRecoveryClaimPollSchema>;
/**
 * Describes the approve agent recovery claim shape.
 */
export type ApproveAgentRecoveryClaim = z.infer<typeof approveAgentRecoveryClaimSchema>;
/**
 * Describes the deny agent recovery claim shape.
 */
export type DenyAgentRecoveryClaim = z.infer<typeof denyAgentRecoveryClaimSchema>;

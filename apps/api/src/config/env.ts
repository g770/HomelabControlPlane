/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the env logic for the repository.
 */
import { z } from 'zod';

const booleanish = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'true' ||
      normalized === '1' ||
      normalized === 'yes' ||
      normalized === 'on'
    ) {
      return true;
    }
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'no' ||
      normalized === 'off'
    ) {
      return false;
    }
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('8h'),
  APP_MASTER_KEY: z.string().min(32),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  RATE_LIMIT_TTL: z.coerce.number().default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().default(120),
  AI_RETENTION_DAYS: z.coerce.number().default(30),
  AGENT_INSTALL_ENABLED: booleanish.default(false),
  AGENT_BINARY_STORE_ROOT: z.string().default('/opt/homelab-agent-binaries'),
  AGENT_BINARY_DEFAULT_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .default('v0.2.0'),
  AGENT_INSTALL_QUEUE_NAME: z.string().default('agent-install-jobs'),
  AGENT_INSTALL_SECRET_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  DISCOVERY_ENABLED: booleanish.default(true),
  DISCOVERY_AI_ENABLED: booleanish.default(true),
  DISCOVERY_INTERVAL_SEC: z.coerce.number().int().min(60).default(600),
  DISCOVERY_AI_CATALOG_TTL_SEC: z.coerce.number().int().min(300).default(86_400),
  DISCOVERY_MAX_HOSTS_PER_RUN: z.coerce.number().int().min(1).max(500).default(120),
  DISCOVERY_MAX_PROBES_PER_HOST: z.coerce.number().int().min(1).max(100).default(12),
  DISCOVERY_AUTO_UPSERT: booleanish.default(true),
  DISCOVERY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  DISCOVERY_SUBNET_ENABLED: booleanish.default(false),
  DISCOVERY_SUBNET_SCHEDULED: booleanish.default(false),
  DISCOVERY_SUBNET_SCHEDULED_WRITE_APPROVED: booleanish.default(false),
  DISCOVERY_SUBNET_DEFAULT_CIDRS: z.string().default('10.0.0.0/24,172.16.0.0/24,192.168.1.0/24'),
  DISCOVERY_SUBNET_MAX_HOSTS: z.coerce.number().int().min(1).max(4096).default(512),
  DISCOVERY_SUBNET_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(24),
  DISCOVERY_SUBNET_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(750),
  DISCOVERY_SUBNET_MCP_TOOL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(120_000),
  DASHBOARD_AGENT_ENABLED: booleanish.default(true),
  DASHBOARD_AGENT_INTERVAL_SEC: z.coerce.number().int().min(60).max(86_400).default(300),
});

/**
 * Describes the env shape.
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Loads env.
 */
export const loadEnv = (): Env => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(', ');
    throw new Error(`Invalid env: ${message}`);
  }

  return parsed.data;
};

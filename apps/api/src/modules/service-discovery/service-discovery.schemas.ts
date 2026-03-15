/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module defines the service discovery schemas validation and transport schemas.
 */
import { z } from 'zod';
import {
  serviceDiscoveryCatalogEnvelopeSchema,
  serviceDiscoverySignatureSchema,
} from './service-discovery.catalog';

/**
 * Implements discovery catalog record schema.
 */
export const discoveryCatalogRecordSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(['BUILTIN', 'HYBRID']),
    expiresAt: z.string().datetime(),
    lastError: z.string().nullable(),
    serviceCount: z.number().int().nonnegative(),
    services: z.array(serviceDiscoverySignatureSchema),
  })
  .strict();

/**
 * Implements discovery run summary schema.
 */
export const discoveryRunSummarySchema = z
  .object({
    hostCount: z.number().int().nonnegative(),
    probeCount: z.number().int().nonnegative(),
    detectedCount: z.number().int().nonnegative(),
    upsertCount: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    verification: z
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
      .optional(),
    appliedConfig: z
      .object({
        subnetScan: z
          .object({
            enabled: z.boolean(),
            cidrs: z.array(z.string().min(1)).max(128),
            includeAutoLocalCidrs: z.boolean(),
            includeCommonWebPorts: z.boolean(),
            maxHosts: z.number().int().min(1).max(4096),
            concurrency: z.number().int().min(1).max(128),
            connectTimeoutMs: z.number().int().min(100).max(10_000),
            toolCallTimeoutMs: z.number().int().min(5_000).max(600_000),
          })
          .strict(),
      })
      .strict()
      .optional(),
    subnet: z
      .object({
        scannerAgents: z.number().int().nonnegative(),
        cidrCount: z.number().int().nonnegative(),
        hostsScanned: z.number().int().nonnegative(),
        hostsReachable: z.number().int().nonnegative(),
        detections: z.number().int().nonnegative(),
        upserts: z.number().int().nonnegative(),
        warnings: z.array(z.string().min(1).max(200)).max(50),
      })
      .optional(),
  })
  .strict();

/**
 * Implements discovery run history item schema.
 */
export const discoveryRunHistoryItemSchema = z
  .object({
    id: z.string().uuid(),
    trigger: z.enum(['SCHEDULE', 'MANUAL']),
    triggeredByUserId: z.string().uuid().nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    status: z.enum(['RUNNING', 'COMPLETED', 'FAILED']),
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
 * Implements discovery run history response schema.
 */
export const discoveryRunHistoryResponseSchema = z
  .object({
    runs: z.array(discoveryRunHistoryItemSchema),
  })
  .strict();

/**
 * Implements ai catalog envelope schema.
 */
export const aiCatalogEnvelopeSchema = serviceDiscoveryCatalogEnvelopeSchema;

/**
 * Describes the discovery catalog record shape.
 */
export type DiscoveryCatalogRecord = z.infer<typeof discoveryCatalogRecordSchema>;
/**
 * Describes the discovery run summary shape.
 */
export type DiscoveryRunSummary = z.infer<typeof discoveryRunSummarySchema>;
/**
 * Describes the discovery run history item shape.
 */
export type DiscoveryRunHistoryItem = z.infer<typeof discoveryRunHistoryItemSchema>;

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the types route view.
 */
/**
 * Describes the host fact shape.
 */
export type HostFact = {
  id?: string;
  createdAt?: string;
  snapshot?: unknown;
};

/**
 * Describes the metric point shape.
 */
export type MetricPoint = {
  at: number;
  value: number;
};

/**
 * Describes the throughput point shape.
 */
export type ThroughputPoint = {
  at: number;
  primary: number;
  secondary: number;
};

/**
 * Describes the host summary section shape.
 */
export type HostSummarySection = {
  title: string;
  bullets: string[];
};

/**
 * Describes the host detail summary shape.
 */
export type HostDetailSummary = {
  hostId: string;
  hostName: string;
  generatedAt: string;
  generatedByAi: boolean;
  overview: string[];
  sections: {
    facts: HostSummarySection;
    containers: HostSummarySection;
    systemServices: HostSummarySection;
    storage: HostSummarySection;
    network: HostSummarySection;
  };
};

/**
 * Describes the host telemetry config response shape.
 */
export type HostTelemetryConfigResponse = {
  hostId: string;
  agentId: string;
  config: {
    heartbeatSec: number;
    factsSec: number;
    inventorySec: number;
    minSec: number;
    maxSec: number;
    updatedAt: string;
  };
  fetchedAt: string;
};

/**
 * Describes the host telemetry refresh response shape.
 */
export type HostTelemetryRefreshResponse = {
  hostId: string;
  agentId: string;
  queued: boolean;
  reason: string;
  requestedAt: string;
};

/**
 * Describes the host service instance shape.
 */
export type HostServiceInstance = {
  id?: string;
  name?: string;
  status?: string;
  endpoint?: string | null;
  lastSeenAt?: string | null;
  service?: {
    name?: string;
  } | null;
  metadata?: Record<string, unknown>;
};

/**
 * Describes the host event shape.
 */
export type HostEvent = {
  id: string;
  type: string;
  message: string;
  severity?: string;
  createdAt?: string;
};

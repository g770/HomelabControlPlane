/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the integration adapter logic for the repository.
 */
/**
 * Describes the integration sync record shape.
 */
export type IntegrationSyncRecord = {
  hostName: string;
  serviceName: string;
  status: 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';
  tags?: string[];
};

/**
 * Describes the integration adapter shape.
 */
export type IntegrationAdapter = {
  type: 'PROXMOX';
  test(
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ): Promise<{ ok: boolean; details: Record<string, unknown> }>;
  sync(
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ): Promise<IntegrationSyncRecord[]>;
};

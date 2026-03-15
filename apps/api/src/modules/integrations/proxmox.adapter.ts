/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module provides the proxmox adapter integration helpers for the surrounding feature.
 */
import type { IntegrationAdapter, IntegrationSyncRecord } from './integration-adapter';
import {
  extractProxmoxApiError,
  mapProxmoxFetchError,
  ProxmoxClient,
  readString,
  toRecord,
} from './proxmox.client';

/**
 * Implements the proxmox adapter class.
 */
export class ProxmoxAdapter implements IntegrationAdapter {
  readonly type = 'PROXMOX' as const;

  /**
   * Handles test.
   */
  async test(config: Record<string, unknown>, credentials: Record<string, unknown>) {
    if (config.mock === true) {
      return { ok: true, details: { mode: 'mock' } };
    }

    const client = new ProxmoxClient(
      ProxmoxClient.readConfig(config),
      ProxmoxClient.readCredentials(credentials),
    );

    let response: { status: number; data: unknown };
    try {
      response = await client.getJson('/api2/json/version');
    } catch (error) {
      return { ok: false, details: { error: mapProxmoxFetchError(error) } };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        details: {
          status: response.status,
          error: extractProxmoxApiError(response.data) ?? 'Proxmox version request failed',
        },
      };
    }

    const data = toRecord(response.data);
    return { ok: true, details: { version: data?.data ?? null } };
  }

  async sync(
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
  ): Promise<IntegrationSyncRecord[]> {
    if (config.mock === true) {
      return [
        {
          hostName: 'pve-node-1',
          serviceName: 'pve-qemu-vm100',
          status: 'OK',
          tags: ['proxmox', 'vm'],
        },
        {
          hostName: 'pve-node-1',
          serviceName: 'pve-lxc-201',
          status: 'WARN',
          tags: ['proxmox', 'lxc'],
        },
      ];
    }

    const client = new ProxmoxClient(
      ProxmoxClient.readConfig(config),
      ProxmoxClient.readCredentials(credentials),
    );
    let response: { status: number; data: unknown };
    try {
      response = await client.getJson('/api2/json/nodes');
    } catch (error) {
      throw new Error(mapProxmoxFetchError(error));
    }

    if (response.status < 200 || response.status >= 300) {
      const apiError = extractProxmoxApiError(response.data);
      throw new Error(`Proxmox sync failed: ${response.status}${apiError ? ` (${apiError})` : ''}`);
    }

    const body = toRecord(response.data);
    const nodes = Array.isArray(body?.data) ? body.data : [];

    const output: IntegrationSyncRecord[] = [];
    for (const rawNode of nodes) {
      const node = toRecord(rawNode);
      const nodeName = typeof node?.node === 'string' ? node.node : '';
      if (!nodeName) {
        continue;
      }
      const nodeStatus = readString(node?.status) ?? 'unknown';
      output.push({
        hostName: nodeName,
        serviceName: `proxmox-node-${nodeName}`,
        status: nodeStatus === 'online' ? 'OK' : 'WARN',
        tags: ['proxmox', 'node'],
      });
    }

    return output;
  }
}

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the integrations logic for the repository.
 */
import { createDecipheriv, createHash } from 'crypto';

// Shared integration helpers used by worker jobs and unit tests.
export type IntegrationTypeValue = 'PROXMOX';

/**
 * Describes the integration sync record shape.
 */
export type IntegrationSyncRecord = {
  hostName: string;
  serviceName: string;
  status: 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';
  tags?: string[];
};

type Fetcher = typeof fetch;

// Decrypts credential blobs stored as AES-256-GCM payload envelopes.
export function decryptJson(masterKey: string, encrypted: string): Record<string, unknown> {
  const key = createHash('sha256').update(masterKey).digest();
  const payload = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as {
    iv: string;
    authTag: string;
    ciphertext: string;
  };
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
}

// Polls integration APIs and normalizes external records into a common shape.
export async function syncIntegrationRecords(
  type: IntegrationTypeValue,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<IntegrationSyncRecord[]> {
  if (config.mock === true) {
    return buildMockIntegrationRecords(type);
  }

  const baseUrl = String(config.baseUrl ?? '');
  if (!baseUrl) {
    throw new Error('Missing baseUrl in integration config');
  }

  if (type === 'PROXMOX') {
    const token = resolveProxmoxToken(credentials);
    const response = await fetcher(`${baseUrl}/api2/json/nodes`, {
      headers: { Authorization: `PVEAPIToken=${token}` },
    });
    if (!response.ok) {
      throw new Error(`Proxmox sync failed: ${response.status}`);
    }
    const body = (await response.json()) as { data?: Array<{ node: string; status?: string }> };
    return (body.data ?? []).map((node) => ({
      hostName: node.node,
      serviceName: `proxmox-node-${node.node}`,
      status: node.status === 'online' ? 'OK' : 'WARN',
      tags: ['proxmox'],
    }));
  }

  return [];
}

// Deterministic fixtures used when integrations run in mock mode.
function buildMockIntegrationRecords(type: IntegrationTypeValue): IntegrationSyncRecord[] {
  switch (type) {
    case 'PROXMOX':
      return [
        { hostName: 'pve-node-1', serviceName: 'pve-qemu-vm100', status: 'OK', tags: ['proxmox'] },
        { hostName: 'pve-node-1', serviceName: 'pve-lxc-201', status: 'WARN', tags: ['proxmox'] },
      ];
    default:
      return [];
  }
}

/**
 * Implements resolve proxmox token.
 */
function resolveProxmoxToken(credentials: Record<string, unknown>) {
  if (typeof credentials.apiToken === 'string' && credentials.apiToken.trim().length > 0) {
    return credentials.apiToken.trim();
  }

  const apiTokenId =
    typeof credentials.apiTokenId === 'string' ? credentials.apiTokenId.trim() : '';
  const apiTokenSecret =
    typeof credentials.apiTokenSecret === 'string' ? credentials.apiTokenSecret.trim() : '';

  if (!apiTokenId || !apiTokenSecret) {
    throw new Error('Missing Proxmox API token credentials');
  }

  return `${apiTokenId}=${apiTokenSecret}`;
}

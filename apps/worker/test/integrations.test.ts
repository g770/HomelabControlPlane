/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the integrations test behavior.
 */
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { decryptJson, syncIntegrationRecords } from '../src/integrations';

describe('worker integrations helpers', () => {
  it('decryptJson round-trips encrypted credential payloads', () => {
    const masterKey = 'this_is_a_test_master_key_with_enough_entropy_12345';
    const payload = { apiToken: 'secret-token', endpoint: 'https://pve.local' };
    const encrypted = encryptJson(masterKey, payload);

    const decrypted = decryptJson(masterKey, encrypted);
    expect(decrypted).toEqual(payload);
  });

  it('decryptJson throws when key is incorrect', () => {
    const encrypted = encryptJson('correct-master-key', { apiToken: 'secret-token' });
    expect(() => decryptJson('wrong-master-key', encrypted)).toThrowError();
  });

  it('syncIntegrationRecords returns deterministic mock records', async () => {
    const proxmox = await syncIntegrationRecords('PROXMOX', { mock: true }, {});

    expect(proxmox.length).toBeGreaterThan(0);
    expect(proxmox[0]?.tags).toContain('proxmox');
  });

  it('syncIntegrationRecords requires baseUrl when not in mock mode', async () => {
    await expect(syncIntegrationRecords('PROXMOX', {}, { apiToken: 'abc' })).rejects.toThrow(
      'Missing baseUrl in integration config',
    );
  });

  it('maps proxmox API node responses into sync records', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { node: 'pve1', status: 'online' },
            { node: 'pve2', status: 'offline' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const records = await syncIntegrationRecords(
      'PROXMOX',
      { baseUrl: 'https://proxmox.local' },
      { apiToken: 'token-123' },
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith('https://proxmox.local/api2/json/nodes', {
      headers: { Authorization: 'PVEAPIToken=token-123' },
    });
    expect(records).toEqual([
      { hostName: 'pve1', serviceName: 'proxmox-node-pve1', status: 'OK', tags: ['proxmox'] },
      { hostName: 'pve2', serviceName: 'proxmox-node-pve2', status: 'WARN', tags: ['proxmox'] },
    ]);
  });

  it('accepts split Proxmox token credentials from the explicit integration form', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ node: 'pve1', status: 'online' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const records = await syncIntegrationRecords(
      'PROXMOX',
      { baseUrl: 'https://proxmox.local' },
      {
        apiTokenId: 'root@pam!dashboard',
        apiTokenSecret: 'secret-456',
      },
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith('https://proxmox.local/api2/json/nodes', {
      headers: { Authorization: 'PVEAPIToken=root@pam!dashboard=secret-456' },
    });
    expect(records).toEqual([
      { hostName: 'pve1', serviceName: 'proxmox-node-pve1', status: 'OK', tags: ['proxmox'] },
    ]);
  });

  it('requires a usable Proxmox API token', async () => {
    await expect(
      syncIntegrationRecords('PROXMOX', { baseUrl: 'https://proxmox.local' }, {}),
    ).rejects.toThrow('Missing Proxmox API token credentials');
  });
});

/**
 * Implements encrypt json.
 */
function encryptJson(masterKey: string, payload: Record<string, unknown>) {
  const key = createHash('sha256').update(masterKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

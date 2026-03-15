/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the proxmox service test behavior.
 */
import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxmoxClient } from '../src/modules/integrations/proxmox.client';
import { ProxmoxService } from '../src/modules/proxmox/proxmox.service';

vi.mock('@prisma/client', () => ({
  IntegrationType: {
    PROXMOX: 'PROXMOX',
  },
}));

describe('ProxmoxService', () => {
  const prisma = {
    integration: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  };
  const securityService = {
    decryptJson: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: ProxmoxService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ProxmoxService(prisma as never, securityService as never, auditService as never);
    prisma.integration.findFirst.mockResolvedValue({
      id: 'integration-1',
      name: 'Proxmox Lab',
      type: 'PROXMOX',
      enabled: true,
      config: {
        baseUrl: 'https://pve.local:8006',
        allowInsecureTls: false,
      },
      credential: {
        encryptedBlob: 'encrypted',
      },
      lastSyncAt: null,
      lastStatus: null,
      lastError: null,
      createdAt: new Date('2026-03-14T00:00:00.000Z'),
      updatedAt: new Date('2026-03-14T00:00:00.000Z'),
    });
    securityService.decryptJson.mockReturnValue({
      apiTokenId: 'root@pam!dashboard',
      apiTokenSecret: 'secret-token',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters task history to the selected guest VMID', async () => {
    const getJsonSpy = vi
      .spyOn(ProxmoxClient.prototype, 'getJson')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: [{ type: 'qemu', vmid: 100, node: 'pve1', name: 'vm100', status: 'running' }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: [
            {
              upid: 'UPID:pve1:00001234:00000001:12345678:start:100:root@pam:',
              node: 'pve1',
              id: '100',
              type: 'start',
              status: 'OK',
            },
            {
              upid: 'UPID:pve1:00001234:00000001:12345678:start:101:root@pam:',
              node: 'pve1',
              id: '101',
              type: 'start',
              status: 'OK',
            },
          ],
        },
      });

    const result = await service.listGuestTasks('integration-1', 'qemu', 100, '10');

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.upid).toContain(':100:');
    expect(getJsonSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid lifecycle actions before issuing a Proxmox write request', async () => {
    vi.spyOn(ProxmoxClient.prototype, 'getJson').mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ type: 'qemu', vmid: 100, node: 'pve1', name: 'vm100', status: 'running' }],
      },
    });
    const postJsonSpy = vi.spyOn(ProxmoxClient.prototype, 'postJson');

    await expect(
      service.performGuestAction('user-1', 'integration-1', 'qemu', 100, 'start'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(postJsonSpy).not.toHaveBeenCalled();
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it('audits successful guest lifecycle actions and returns the Proxmox task id', async () => {
    vi.spyOn(ProxmoxClient.prototype, 'getJson').mockResolvedValueOnce({
      status: 200,
      data: {
        data: [{ type: 'qemu', vmid: 100, node: 'pve1', name: 'vm100', status: 'stopped' }],
      },
    });
    const postJsonSpy = vi.spyOn(ProxmoxClient.prototype, 'postJson').mockResolvedValueOnce({
      status: 200,
      data: {
        data: 'UPID:pve1:00001234:00000001:12345678:start:100:root@pam:',
      },
    });

    const result = await service.performGuestAction(
      'user-1',
      'integration-1',
      'qemu',
      100,
      'start',
    );

    expect(postJsonSpy).toHaveBeenCalledWith('/api2/json/nodes/pve1/qemu/100/status/start');
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'proxmox.guest.start',
        targetType: 'proxmox_guest',
        success: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      upid: 'UPID:pve1:00001234:00000001:12345678:start:100:root@pam:',
    });
  });
});

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the proxmox controller int test behavior.
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxmoxController } from '../src/modules/proxmox/proxmox.controller';
import { ProxmoxService } from '../src/modules/proxmox/proxmox.service';

vi.mock('@prisma/client', () => ({
  IntegrationType: {
    PROXMOX: 'PROXMOX',
  },
}));

describe('ProxmoxController', () => {
  const proxmoxServiceMock = {
    listIntegrations: vi.fn(),
    listGuests: vi.fn(),
    getGuestDetail: vi.fn(),
    listGuestTasks: vi.fn(),
    performGuestAction: vi.fn(),
  };

  let controller: ProxmoxController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ProxmoxController(proxmoxServiceMock as unknown as ProxmoxService);
  });

  it('delegates list endpoints to the service with normalized filters', async () => {
    proxmoxServiceMock.listIntegrations.mockResolvedValueOnce([]);
    proxmoxServiceMock.listGuests.mockResolvedValueOnce({
      integration: { id: 'integration-1' },
      summary: { total: 0, running: 0, stopped: 0, qemu: 0, lxc: 0 },
      filters: { nodes: [] },
      guests: [],
    });
    proxmoxServiceMock.getGuestDetail.mockResolvedValueOnce({ guest: { vmid: 100 } });
    proxmoxServiceMock.listGuestTasks.mockResolvedValueOnce({ tasks: [] });

    await controller.listIntegrations();
    await controller.listGuests('integration-1', 'qemu', 'running', undefined, 'pve1', 'vm100');
    await controller.getGuestDetail('integration-1', 'qemu', '100');
    await controller.listGuestTasks('integration-1', 'qemu', '100', '15');

    expect(proxmoxServiceMock.listIntegrations).toHaveBeenCalledTimes(1);
    expect(proxmoxServiceMock.listGuests).toHaveBeenCalledWith('integration-1', {
      kind: 'qemu',
      status: 'running',
      node: 'pve1',
      search: 'vm100',
    });
    expect(proxmoxServiceMock.getGuestDetail).toHaveBeenCalledWith('integration-1', 'qemu', 100);
    expect(proxmoxServiceMock.listGuestTasks).toHaveBeenCalledWith(
      'integration-1',
      'qemu',
      100,
      '15',
    );
  });

  it('rejects invalid guest kinds, actions, and VMIDs before calling the service', async () => {
    expect(() => controller.getGuestDetail('integration-1', 'badkind', '100')).toThrow(
      BadRequestException,
    );
    expect(() =>
      controller.performGuestAction({ sub: 'user-1' }, 'integration-1', 'qemu', '0', 'start', {
        confirm: true,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.performGuestAction(
        { sub: 'user-1' },
        'integration-1',
        'qemu',
        '100',
        'hibernate',
        { confirm: true },
      ),
    ).toThrow(BadRequestException);

    expect(proxmoxServiceMock.getGuestDetail).not.toHaveBeenCalled();
    expect(proxmoxServiceMock.performGuestAction).not.toHaveBeenCalled();
  });

  it('delegates valid lifecycle actions to the service', async () => {
    proxmoxServiceMock.performGuestAction.mockResolvedValueOnce({
      ok: true,
      upid: 'UPID:pve1:00001234:00000001:12345678:start:100:root@pam:',
    });

    const result = await controller.performGuestAction(
      { sub: 'user-1' },
      'integration-1',
      'qemu',
      '100',
      'start',
      { confirm: true },
    );

    expect(proxmoxServiceMock.performGuestAction).toHaveBeenCalledWith(
      'user-1',
      'integration-1',
      'qemu',
      100,
      'start',
    );
    expect(result).toEqual({
      ok: true,
      upid: 'UPID:pve1:00001234:00000001:12345678:start:100:root@pam:',
    });
  });
});

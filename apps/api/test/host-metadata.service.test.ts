/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the host metadata service test behavior.
 */
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../src/modules/inventory/inventory.service';

describe('InventoryService.updateHostMetadata', () => {
  const prisma = {
    host: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: InventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InventoryService(prisma as any, auditService as any);
  });

  it('persists normalized tags and host type override, then writes audit event', async () => {
    prisma.host.findUnique.mockResolvedValueOnce({ id: 'host-1' });
    prisma.host.update.mockResolvedValueOnce({
      id: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
      hostname: 'host-alpha',
      tags: ['Edge', 'rack-1', 'container'],
      updatedAt: new Date('2026-03-03T12:00:00.000Z'),
    });

    const response = await service.updateHostMetadata('user-1', 'host-1', {
      confirm: true,
      tags: ['Edge', 'edge', 'rack-1'],
      hostType: 'CONTAINER',
    });

    expect(prisma.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'host-1' },
        data: {
          tags: ['Edge', 'rack-1', 'container'],
        },
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'host.metadata.update',
        targetType: 'host',
        targetId: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
        success: true,
      }),
    );
    expect(response).toEqual({
      hostId: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
      hostName: 'host-alpha',
      tags: ['Edge', 'rack-1', 'container'],
      hostType: 'CONTAINER',
      updatedAt: '2026-03-03T12:00:00.000Z',
    });
  });

  it('throws not found for unknown host id', async () => {
    prisma.host.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.updateHostMetadata('user-1', 'missing-host', {
        confirm: true,
        tags: ['edge'],
        hostType: 'MACHINE',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prefers explicit host type override when listing hosts', async () => {
    prisma.host.findMany.mockResolvedValueOnce([
      {
        id: 'host-1',
        hostname: 'host-alpha',
        tags: ['docker', 'machine'],
        status: 'OK',
        cpuPct: 1,
        memPct: 2,
        diskPct: 3,
        lastSeenAt: null,
        agentVersion: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: {
          endpoint: 'http://shared-endpoint:8080',
          mcpEndpoint: 'http://shared-endpoint:8080/mcp',
        },
        facts: [
          {
            snapshot: {
              network: {
                primaryIp: '192.168.1.10',
              },
            },
          },
        ],
      },
    ]);

    const hosts = await service.listHosts();
    expect(hosts[0]?.hostType).toBe('MACHINE');
    expect(hosts[0]?.hostIp).toBe('192.168.1.10');
  });

  it('does not fall back to shared agent endpoints when a host has no resolved IP', async () => {
    prisma.host.findMany.mockResolvedValueOnce([
      {
        id: 'host-2',
        hostname: 'host-beta',
        tags: ['docker'],
        status: 'OK',
        cpuPct: 1,
        memPct: 2,
        diskPct: 3,
        lastSeenAt: null,
        agentVersion: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        agent: {
          endpoint: 'http://shared-endpoint:8080',
          mcpEndpoint: 'http://shared-endpoint:8080/mcp',
        },
        facts: [],
      },
    ]);

    const hosts = await service.listHosts();
    expect(hosts[0]?.hostIp).toBeNull();
  });
});

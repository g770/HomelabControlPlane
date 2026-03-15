/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agents inventory service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsService } from '../src/modules/agents/agents.service';

describe('AgentsService.inventory', () => {
  const prisma = {
    agent: {
      findUnique: vi.fn(),
    },
    host: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const securityService = {
    hashToken: vi.fn(),
    encryptJson: vi.fn(),
    constantTimeEquals: vi.fn(),
  };

  const eventsService = {
    emit: vi.fn(),
  };

  const auditService = {
    write: vi.fn(),
  };

  let service: AgentsService;

  beforeEach(() => {
    vi.clearAllMocks();
    securityService.hashToken.mockImplementation((value: string) => `hash:${value}`);
    securityService.constantTimeEquals.mockReturnValue(true);

    service = new AgentsService(
      prisma as any,
      securityService as any,
      eventsService as any,
      auditService as any,
    );
  });

  it('persists service metadata from inventory payload', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      tokenHash: 'hash:agent-token',
      revokedAt: null,
    });
    prisma.host.findUnique.mockResolvedValueOnce({
      id: 'host-1',
      hostname: 'host-alpha',
      tags: ['linux', 'labagent'],
    });

    const serviceUpsert = vi.fn().mockResolvedValue({ id: 'service-1' });
    const serviceInstanceUpsert = vi.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<void>) =>
      callback({
        service: { upsert: serviceUpsert },
        serviceInstance: { upsert: serviceInstanceUpsert },
      }),
    );

    await service.inventory('agent-1', 'agent-token', {
      hostname: 'host-alpha',
      services: [
        {
          name: 'nginx.service',
          status: 'OK',
          metadata: {
            runtime: 'systemd',
            state: 'running',
            active: 'active',
            load: 'loaded',
          },
        },
      ],
      containers: [],
      systemd: {
        failedCount: 0,
        units: [],
      },
      network: {},
      storage: {},
    });

    expect(serviceInstanceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          metadata: expect.objectContaining({
            runtime: 'systemd',
            state: 'running',
            active: 'active',
            load: 'loaded',
          }),
        }),
        create: expect.objectContaining({
          metadata: expect.objectContaining({
            runtime: 'systemd',
            state: 'running',
            active: 'active',
            load: 'loaded',
          }),
        }),
      }),
    );
  });

  it('accepts services without metadata and stores undefined metadata', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      tokenHash: 'hash:agent-token',
      revokedAt: null,
    });
    prisma.host.findUnique.mockResolvedValueOnce({
      id: 'host-1',
      hostname: 'host-alpha',
      tags: ['linux', 'labagent'],
    });

    const serviceUpsert = vi.fn().mockResolvedValue({ id: 'service-1' });
    const serviceInstanceUpsert = vi.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementationOnce(async (callback: (tx: any) => Promise<void>) =>
      callback({
        service: { upsert: serviceUpsert },
        serviceInstance: { upsert: serviceInstanceUpsert },
      }),
    );

    await service.inventory('agent-1', 'agent-token', {
      hostname: 'host-alpha',
      services: [
        {
          name: 'cron.service',
          status: 'WARN',
        },
      ],
      containers: [],
      systemd: {
        failedCount: 1,
        units: [{ name: 'cron.service', state: 'exited' }],
      },
      network: {},
      storage: {},
    });

    const upsertArgs = serviceInstanceUpsert.mock.calls[0]?.[0];
    expect(upsertArgs?.update?.metadata).toBeUndefined();
    expect(upsertArgs?.create?.metadata).toBeUndefined();
  });
});

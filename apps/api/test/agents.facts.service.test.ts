/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agents facts service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({
  Prisma: {
    TransactionIsolationLevel: {
      ReadCommitted: 'ReadCommitted',
    },
  },
}));

import { AgentsService } from '../src/modules/agents/agents.service';

describe('AgentsService.facts', () => {
  const prisma = {
    agent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    host: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    hostFact: {
      create: vi.fn(),
    },
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

  it('claims an existing host by resolved primary IP when facts hostname differs', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'agent-host',
      tokenHash: 'hash:agent-token',
      revokedAt: null,
    });

    const existingHost = {
      id: 'canonical-host',
      hostname: 'legacy-host',
      tags: ['linux'],
      status: 'OK',
      cpuPct: 0,
      memPct: 0,
      diskPct: 0,
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
      agentVersion: '0.1.0',
      createdAt: new Date('2026-02-20T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      agent: null,
      facts: [],
    };

    prisma.host.findMany.mockImplementation(async (args: { where?: Record<string, any> }) => {
      if (args.where?.id === 'agent-host') {
        return [];
      }
      return [existingHost];
    });
    prisma.host.update.mockResolvedValueOnce({
      id: 'canonical-host',
    });
    prisma.hostFact.create.mockResolvedValueOnce({
      id: 'fact-1',
    });
    prisma.agent.update.mockResolvedValueOnce({
      id: 'agent-1',
    });

    await service.facts('agent-1', 'agent-token', {
      hostname: 'media-node',
      tags: ['nas'],
      cpuPct: 12,
      memPct: 34,
      diskPct: 56,
      agentVersion: '0.2.0',
      snapshot: {
        network: {
          primaryIp: '192.168.1.25',
        },
      },
    });

    expect(prisma.host.create).not.toHaveBeenCalled();
    expect(prisma.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'canonical-host' },
        data: expect.objectContaining({
          tags: expect.arrayContaining(['linux', 'nas']),
        }),
      }),
    );
    expect(prisma.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'agent-1' },
        data: expect.objectContaining({
          hostId: 'canonical-host',
        }),
      }),
    );
    expect(prisma.hostFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hostId: 'canonical-host',
        }),
      }),
    );
    expect(eventsService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: 'canonical-host',
        type: 'host.facts',
      }),
    );
  });

  it('creates a new host when the hostname matches another host but the known primary IP differs', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: null,
      tokenHash: 'hash:agent-token',
      revokedAt: null,
    });

    const unrelatedHost = {
      id: 'host-legacy',
      hostname: 'server-template',
      resolvedPrimaryIp: '192.168.10.229',
      tags: ['linux'],
      status: 'OK',
      cpuPct: 0,
      memPct: 0,
      diskPct: 0,
      lastSeenAt: new Date('2026-03-14T20:17:32.708Z'),
      agentVersion: '0.2.0',
      createdAt: new Date('2026-03-14T20:00:00.000Z'),
      updatedAt: new Date('2026-03-14T20:17:32.708Z'),
      agent: null,
      facts: [],
    };

    prisma.host.findMany.mockImplementation(async (args: { where?: Record<string, any> }) => {
      if (args.where?.hostname?.equals === 'server-template') {
        return [unrelatedHost];
      }
      return [unrelatedHost];
    });
    prisma.host.create.mockResolvedValueOnce({
      id: 'host-new',
    });
    prisma.hostFact.create.mockResolvedValueOnce({
      id: 'fact-1',
    });
    prisma.agent.update.mockResolvedValueOnce({
      id: 'agent-1',
    });

    await service.facts('agent-1', 'agent-token', {
      hostname: 'server-template',
      tags: ['nas'],
      cpuPct: 12,
      memPct: 34,
      diskPct: 56,
      agentVersion: '0.2.0',
      snapshot: {
        network: {
          primaryIp: '192.168.10.76',
        },
      },
    });

    expect(prisma.host.update).not.toHaveBeenCalled();
    expect(prisma.host.create).toHaveBeenCalledWith({
      data: {
        hostname: 'server-template',
        resolvedPrimaryIp: '192.168.10.76',
        tags: ['nas'],
        cpuPct: 12,
        memPct: 34,
        diskPct: 56,
        lastSeenAt: expect.any(Date),
        status: 'OK',
        agentVersion: '0.2.0',
      },
    });
    expect(prisma.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'agent-1' },
        data: expect.objectContaining({
          hostId: 'host-new',
        }),
      }),
    );
    expect(prisma.hostFact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hostId: 'host-new',
        }),
      }),
    );
  });
});

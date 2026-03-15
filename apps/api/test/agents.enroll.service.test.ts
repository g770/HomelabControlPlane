/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agents enroll service test behavior.
 */
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsService } from '../src/modules/agents/agents.service';

describe('AgentsService.enroll', () => {
  const prisma = {
    enrollmentToken: {
      findUnique: vi.fn(),
    },
    host: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    agent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };

  const securityService = {
    hashToken: vi.fn(),
    encryptJson: vi.fn(),
    constantTimeEquals: vi.fn(),
    signOpaqueJson: vi.fn(),
  };

  const eventsService = {
    emit: vi.fn(),
  };

  const auditService = {
    write: vi.fn(),
  };

  let service: AgentsService;

  const validPayload = {
    enrollmentToken: '0123456789abcdef0123456789abcdef',
    endpoint: 'http://agent-host:8081',
    mcpEndpoint: 'http://agent-host:8081/mcp',
    displayName: 'lab-agent',
    hostname: 'lab-host-01',
    tags: ['linux', 'labagent'],
    agentVersion: '0.2.0',
    recoveryKeyAlg: 'ED25519',
    recoveryPublicKey: Buffer.alloc(32, 7).toString('base64'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    securityService.hashToken.mockImplementation((value: string) => `hash:${value}`);
    securityService.encryptJson.mockImplementation(() => 'enc-agent-token');
    securityService.signOpaqueJson.mockReturnValue('signed-recovery-certificate');

    service = new AgentsService(
      prisma as any,
      securityService as any,
      eventsService as any,
      auditService as any,
    );
  });

  it('creates a host-bound agent when none exists', async () => {
    prisma.enrollmentToken.findUnique.mockResolvedValueOnce({
      id: 'token-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.host.findMany.mockResolvedValueOnce([]);
    prisma.host.create.mockResolvedValueOnce({
      id: 'host-1',
    });
    prisma.agent.findUnique.mockResolvedValueOnce(null);
    prisma.agent.upsert.mockResolvedValueOnce({
      id: 'agent-1',
    });

    const result = await service.enroll(validPayload);

    expect(result.agentId).toBe('agent-1');
    expect(typeof result.agentToken).toBe('string');
    expect(result.agentToken.length).toBeGreaterThan(0);
    expect(result.recoveryCertificate).toBe('signed-recovery-certificate');
    expect(prisma.host.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hostname: validPayload.hostname,
        }),
      }),
    );
    expect(prisma.agent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hostId: 'host-1' },
        create: expect.objectContaining({
          hostId: 'host-1',
          endpoint: validPayload.endpoint,
          mcpEndpoint: validPayload.mcpEndpoint,
          recoveryKeyAlg: 'ED25519',
          recoveryPublicKey: validPayload.recoveryPublicKey,
        }),
        update: expect.objectContaining({
          status: 'ONLINE',
          revokedAt: null,
          endpoint: validPayload.endpoint,
          mcpEndpoint: validPayload.mcpEndpoint,
          recoveryKeyAlg: 'ED25519',
          recoveryPublicKey: validPayload.recoveryPublicKey,
        }),
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.enroll',
        targetType: 'agent',
        targetId: 'agent-1',
        paramsJson: expect.objectContaining({
          hostname: validPayload.hostname,
          enrollMode: 'created',
        }),
        success: true,
      }),
    );
  });

  it('rotates credentials in place for an existing host-bound agent', async () => {
    prisma.enrollmentToken.findUnique.mockResolvedValueOnce({
      id: 'token-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.host.findMany.mockResolvedValueOnce([
      {
        id: 'host-1',
        hostname: 'lab-host-01',
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
      },
    ]);
    prisma.host.update.mockResolvedValueOnce({
      id: 'host-1',
    });
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-existing',
    });
    prisma.agent.upsert.mockResolvedValueOnce({
      id: 'agent-existing',
    });

    const result = await service.enroll(validPayload);

    expect(result.agentId).toBe('agent-existing');
    expect(result.recoveryCertificate).toBe('signed-recovery-certificate');
    expect(securityService.hashToken).toHaveBeenCalledTimes(2);
    expect(prisma.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'host-1' },
        data: expect.objectContaining({
          status: 'OK',
        }),
      }),
    );
    expect(prisma.agent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hostId: 'host-1' },
        update: expect.objectContaining({
          revokedAt: null,
          status: 'ONLINE',
          enrolledAt: expect.any(Date),
        }),
      }),
    );
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        paramsJson: expect.objectContaining({
          hostname: validPayload.hostname,
          enrollMode: 'rotated',
        }),
      }),
    );
  });

  it('rejects invalid enrollment token before host/agent writes', async () => {
    prisma.enrollmentToken.findUnique.mockResolvedValueOnce({
      id: 'token-revoked',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.enroll(validPayload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.host.create).not.toHaveBeenCalled();
    expect(prisma.host.update).not.toHaveBeenCalled();
    expect(prisma.agent.upsert).not.toHaveBeenCalled();
  });
});

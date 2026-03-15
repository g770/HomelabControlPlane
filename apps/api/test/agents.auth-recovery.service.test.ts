/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agents auth recovery service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsService } from '../src/modules/agents/agents.service';

describe('AgentsService auth and recovery bootstrap', () => {
  const prisma = {
    agent: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    host: {
      update: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    securityService.hashToken.mockImplementation((value: string) => `hash:${value}`);
    securityService.constantTimeEquals.mockImplementation(
      (left: string, right: string) => left === right,
    );
    securityService.signOpaqueJson.mockReturnValue('reissued-recovery-certificate');

    service = new AgentsService(
      prisma as any,
      securityService as any,
      eventsService as any,
      auditService as any,
    );
  });

  it('returns AGENT_NOT_REGISTERED when heartbeat arrives for a missing agent row', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.heartbeat('agent-missing', 'token-1', { status: 'ONLINE' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'AGENT_NOT_REGISTERED',
      }),
    });
  });

  it('returns AGENT_REVOKED when heartbeat arrives for a revoked agent', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      tokenHash: 'hash:token-1',
      revokedAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    await expect(
      service.heartbeat('agent-1', 'token-1', { status: 'ONLINE' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'AGENT_REVOKED',
      }),
    });
  });

  it('reissues a recovery certificate when the agent reports it is missing', async () => {
    const recoveryPublicKey = Buffer.alloc(32, 5).toString('base64');
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      tokenHash: 'hash:token-1',
      revokedAt: null,
      recoveryPublicKey,
    });
    prisma.agent.update.mockResolvedValueOnce({});
    prisma.host.update.mockResolvedValueOnce({});

    const result = await service.heartbeat('agent-1', 'token-1', {
      status: 'ONLINE',
      recoveryCertificateMissing: true,
    });

    expect(result).toEqual({
      ok: true,
      recoveryCertificate: 'reissued-recovery-certificate',
    });
    expect(securityService.signOpaqueJson).toHaveBeenCalledTimes(1);
  });
});

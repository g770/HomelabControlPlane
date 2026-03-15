/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agents revoke delete service test behavior.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsService } from '../src/modules/agents/agents.service';

describe('AgentsService revoke/delete', () => {
  const prisma = {
    agent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  const securityService = {
    hashToken: vi.fn(),
    encryptJson: vi.fn(),
    constantTimeEquals: vi.fn(),
    decryptJson: vi.fn(),
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
    service = new AgentsService(
      prisma as any,
      securityService as any,
      eventsService as any,
      auditService as any,
    );
  });

  it('returns idempotent success when revoking an already revoked agent', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      revokedAt: new Date('2026-02-22T01:00:00.000Z'),
    });

    const result = await service.revoke('agent-1', 'user-1');

    expect(result).toEqual({ ok: true, alreadyRevoked: true });
    expect(prisma.agent.update).not.toHaveBeenCalled();
    expect(eventsService.emit).not.toHaveBeenCalled();
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'agent.revoke',
        targetId: 'agent-1',
        success: true,
      }),
    );
  });

  it('revokes an active agent and returns alreadyRevoked false', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      revokedAt: null,
    });
    prisma.agent.update.mockResolvedValueOnce({});

    const result = await service.revoke('agent-1', 'user-1');

    expect(result).toEqual({ ok: true, alreadyRevoked: false });
    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: {
        revokedAt: expect.any(Date),
        status: 'REVOKED',
      },
    });
    expect(eventsService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.revoked',
        hostId: 'host-1',
      }),
    );
  });

  it('deletes a revoked agent', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      revokedAt: new Date('2026-02-22T01:00:00.000Z'),
    });
    prisma.agent.delete.mockResolvedValueOnce({});

    const result = await service.deleteRevoked('agent-1', 'user-1');

    expect(result).toEqual({ ok: true });
    expect(prisma.agent.delete).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
    });
    expect(eventsService.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.deleted',
        hostId: 'host-1',
      }),
    );
  });

  it('rejects deleting an active agent', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      id: 'agent-1',
      hostId: 'host-1',
      revokedAt: null,
    });

    await expect(service.deleteRevoked('agent-1', 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.agent.delete).not.toHaveBeenCalled();
  });

  it('rejects deleting a missing agent', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce(null);

    await expect(service.deleteRevoked('agent-missing', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.agent.delete).not.toHaveBeenCalled();
  });
});

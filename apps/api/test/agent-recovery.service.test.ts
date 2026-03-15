/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agent recovery service test behavior.
 */
import { generateKeyPairSync, sign } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityService } from '../src/modules/common/security.service';
import { AgentRecoveryService } from '../src/modules/agent-recovery/agent-recovery.service';
import {
  agentRecoveryCertificatePurpose,
  buildRecoveryCertificatePayload,
  buildRecoveryClaimMessage,
} from '../src/modules/agent-recovery/agent-recovery.util';

/**
 * Creates recovery key material.
 */
function createRecoveryKeyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  return {
    privateKey,
    recoveryPublicKey: Buffer.from(String(jwk.x), 'base64url').toString('base64'),
  };
}

describe('AgentRecoveryService', () => {
  const prisma = {
    agentRecoveryClaim: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    host: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const auditService = {
    write: vi.fn(),
  };

  const eventsService = {
    emit: vi.fn(),
  };

  let securityService: SecurityService;
  let service: AgentRecoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.host.findMany.mockResolvedValue([]);
    securityService = new SecurityService({
      getOrThrow: () => 'x'.repeat(32),
    } as any);
    service = new AgentRecoveryService(
      prisma as any,
      securityService,
      auditService as any,
      eventsService as any,
    );
  });

  it('accepts a valid signed recovery claim and creates a pending approval record', async () => {
    const { privateKey, recoveryPublicKey } = createRecoveryKeyMaterial();
    const { challengeToken } = service.createChallenge();
    const recoveryCertificate = securityService.signOpaqueJson(
      agentRecoveryCertificatePurpose,
      buildRecoveryCertificatePayload(recoveryPublicKey),
    );
    const message = buildRecoveryClaimMessage({
      challengeToken,
      hostname: 'lab-host-01',
      primaryIp: '192.168.1.25',
      displayName: 'lab-agent',
      endpoint: 'http://agent-host:8081',
      mcpEndpoint: 'http://agent-host:8081/mcp',
      agentVersion: '0.2.0',
      tags: ['linux', 'labagent'],
    });
    const signature = sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');

    prisma.agentRecoveryClaim.findUnique.mockResolvedValueOnce(null);
    prisma.agentRecoveryClaim.create.mockImplementationOnce(async ({ data }: any) => ({
      id: 'claim-1',
      status: data.status,
    }));

    const result = await service.submitClaim({
      challengeToken,
      recoveryCertificate,
      signature,
      hostname: 'lab-host-01',
      primaryIp: '192.168.1.25',
      displayName: 'lab-agent',
      endpoint: 'http://agent-host:8081',
      mcpEndpoint: 'http://agent-host:8081/mcp',
      agentVersion: '0.2.0',
      tags: ['linux', 'labagent'],
    });

    expect(result.claimId).toBe('claim-1');
    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.pollToken.length).toBeGreaterThan(20);
    expect(prisma.agentRecoveryClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hostname: 'lab-host-01',
          endpoint: 'http://agent-host:8081',
          mcpEndpoint: 'http://agent-host:8081/mcp',
          status: 'PENDING_APPROVAL',
        }),
      }),
    );
  });

  it('approves a pending claim and stores fresh encrypted credentials for the agent', async () => {
    const { recoveryPublicKey } = createRecoveryKeyMaterial();
    const pendingClaim = {
      id: 'claim-1',
      recoveryKeyAlg: 'ED25519',
      recoveryKeyFingerprint: 'fingerprint-1',
      recoveryPublicKey,
      hostname: 'lab-host-01',
      primaryIp: '192.168.1.25',
      displayName: 'lab-agent',
      endpoint: 'http://agent-host:8081',
      mcpEndpoint: 'http://agent-host:8081/mcp',
      agentVersion: '0.2.0',
      tags: ['linux', 'labagent'],
      status: 'PENDING_APPROVAL',
    };

    prisma.agentRecoveryClaim.findUnique.mockResolvedValueOnce(pendingClaim).mockResolvedValueOnce({
      ...pendingClaim,
      status: 'APPROVED_PENDING_AGENT',
      denialReason: null,
      firstSeenAt: new Date('2026-03-12T00:00:00.000Z').toISOString(),
      lastSeenAt: new Date('2026-03-12T00:00:00.000Z').toISOString(),
      approvedAt: new Date('2026-03-12T00:01:00.000Z').toISOString(),
      deniedAt: null,
      completedAt: null,
      createdAt: new Date('2026-03-12T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-03-12T00:01:00.000Z').toISOString(),
      agent: { id: 'agent-1', hostId: 'host-1', status: 'OFFLINE', revokedAt: null },
      approvedBy: { id: 'user-1', email: 'admin@example.com', displayName: 'Admin' },
      deniedBy: null,
    });
    prisma.host.create.mockResolvedValueOnce({ id: 'host-1' });
    prisma.agent.findUnique.mockResolvedValueOnce(null);
    prisma.agent.findFirst.mockResolvedValueOnce(null);
    prisma.agent.create.mockResolvedValueOnce({ id: 'agent-1' });
    prisma.agentRecoveryClaim.update.mockResolvedValueOnce({});

    const result = await service.approveClaim('claim-1', 'user-1', { confirm: true });

    expect(prisma.agentRecoveryClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'claim-1' },
        data: expect.objectContaining({
          status: 'APPROVED_PENDING_AGENT',
          agentId: 'agent-1',
          approvedByUserId: 'user-1',
          approvedCredentialsEncrypted: expect.any(String),
        }),
      }),
    );
    expect(result).toMatchObject({
      id: 'claim-1',
      status: 'APPROVED_PENDING_AGENT',
      agent: {
        id: 'agent-1',
      },
    });
  });

  it('approves a claim by creating a separate host when the same hostname is already active on another IP', async () => {
    const { recoveryPublicKey } = createRecoveryKeyMaterial();
    const pendingClaim = {
      id: 'claim-2',
      recoveryKeyAlg: 'ED25519',
      recoveryKeyFingerprint: 'fingerprint-new',
      recoveryPublicKey,
      hostname: 'server-template',
      primaryIp: '192.168.10.76',
      displayName: 'template-recovery',
      endpoint: 'http://192.168.10.76:8081',
      mcpEndpoint: 'http://192.168.10.76:8081/mcp',
      agentVersion: '0.2.0',
      tags: ['linux', 'labagent'],
      status: 'PENDING_APPROVAL',
    };
    const conflictingHost = {
      id: 'host-1',
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
      agent: {
        id: 'agent-existing',
        revokedAt: null,
        lastSeenAt: new Date('2026-03-14T20:17:32.708Z'),
      },
      facts: [],
    };

    prisma.agentRecoveryClaim.findUnique.mockResolvedValueOnce(pendingClaim).mockResolvedValueOnce({
      ...pendingClaim,
      status: 'APPROVED_PENDING_AGENT',
      denialReason: null,
      firstSeenAt: new Date('2026-03-14T20:02:23.810Z').toISOString(),
      lastSeenAt: new Date('2026-03-14T20:02:23.810Z').toISOString(),
      approvedAt: new Date('2026-03-14T20:36:35.844Z').toISOString(),
      deniedAt: null,
      completedAt: null,
      createdAt: new Date('2026-03-14T20:02:23.810Z').toISOString(),
      updatedAt: new Date('2026-03-14T20:36:35.844Z').toISOString(),
      agent: { id: 'agent-2', hostId: 'host-2', status: 'OFFLINE', revokedAt: null },
      approvedBy: { id: 'user-1', email: 'admin@example.com', displayName: 'Admin' },
      deniedBy: null,
    });
    prisma.host.findMany.mockImplementation(async (args: { where?: Record<string, any> }) => {
      if (args.where?.hostname?.equals === 'server-template') {
        return [conflictingHost];
      }
      return [conflictingHost];
    });
    prisma.host.update.mockResolvedValueOnce({ id: 'host-1' });
    prisma.host.create.mockResolvedValueOnce({ id: 'host-2' });
    prisma.agent.findUnique.mockImplementation(async ({ where }: { where: { hostId: string } }) => {
      if (where.hostId === 'host-1') {
        return {
          id: 'agent-existing',
          recoveryKeyFingerprint: 'fingerprint-existing',
          revokedAt: null,
        };
      }
      return null;
    });
    prisma.agent.findFirst.mockResolvedValueOnce(null);
    prisma.agent.create.mockResolvedValueOnce({ id: 'agent-2' });
    prisma.agentRecoveryClaim.update.mockResolvedValueOnce({});

    const result = await service.approveClaim('claim-2', 'user-1', { confirm: true });

    expect(prisma.host.update).not.toHaveBeenCalled();
    expect(prisma.host.create).toHaveBeenCalledWith({
      data: {
        hostname: 'server-template',
        resolvedPrimaryIp: '192.168.10.76',
        tags: ['linux', 'labagent'],
        status: 'UNKNOWN',
        agentVersion: '0.2.0',
      },
    });
    expect(prisma.agent.findUnique).toHaveBeenCalledWith({
      where: { hostId: 'host-2' },
    });
    expect(prisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hostId: 'host-2',
          recoveryKeyFingerprint: 'fingerprint-new',
        }),
      }),
    );
    expect(result).toMatchObject({
      id: 'claim-2',
      status: 'APPROVED_PENDING_AGENT',
      agent: {
        id: 'agent-2',
        hostId: 'host-2',
      },
    });
  });

  it('summarizes only pending approval claims for the dashboard notice', async () => {
    prisma.agentRecoveryClaim.findMany.mockResolvedValueOnce([
      {
        id: '6e41d0f5-6ec7-4d9a-8da9-7d519e652f52',
        displayName: 'rack-agent-2',
        hostname: 'host-beta',
        lastSeenAt: new Date('2026-03-12T12:06:00.000Z'),
      },
      {
        id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
        displayName: null,
        hostname: 'host-alpha',
        lastSeenAt: new Date('2026-03-12T12:05:00.000Z'),
      },
    ]);

    const result = await service.getSummary();

    expect(prisma.agentRecoveryClaim.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING_APPROVAL' },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        displayName: true,
        hostname: true,
        lastSeenAt: true,
      },
    });
    expect(result.pendingApprovalCount).toBe(2);
    expect(result.pendingApprovalFingerprint).toMatch(/^fnv1a-[0-9a-f]+$/);
    expect(result.pendingClaimsPreview).toEqual([
      {
        id: '6e41d0f5-6ec7-4d9a-8da9-7d519e652f52',
        label: 'rack-agent-2',
        hostname: 'host-beta',
        lastSeenAt: '2026-03-12T12:06:00.000Z',
      },
      {
        id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
        label: 'host-alpha',
        hostname: 'host-alpha',
        lastSeenAt: '2026-03-12T12:05:00.000Z',
      },
    ]);
  });
});

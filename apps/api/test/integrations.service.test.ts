/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the integrations service test behavior.
 */
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';

vi.mock('@prisma/client', () => ({
  IntegrationType: {
    PROXMOX: 'PROXMOX',
  },
}));

/**
 * Creates prisma mock.
 */
function createPrismaMock() {
  const tx = {
    service: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    integration: {
      delete: vi.fn(),
    },
    host: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  };

  return {
    integration: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    tx,
  };
}

describe('IntegrationsService.remove', () => {
  const securityService = {
    encryptJson: vi.fn(),
    decryptJson: vi.fn(),
  };
  const eventsService = {
    emit: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let prisma: ReturnType<typeof createPrismaMock>;
  let service: IntegrationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createPrismaMock();
    service = new IntegrationsService(
      prisma as never,
      securityService as never,
      eventsService as never,
      auditService as never,
    );
  });

  it('deletes the integration, sourced services, and eligible orphan hosts while auditing counts', async () => {
    prisma.integration.findUnique.mockResolvedValue({
      id: 'integration-1',
      type: 'PROXMOX',
    });
    prisma.tx.service.findMany.mockResolvedValue([
      {
        id: 'service-1',
        instances: [
          { id: 'instance-1', hostId: 'host-1' },
          { id: 'instance-2', hostId: 'host-1' },
        ],
      },
      {
        id: 'service-2',
        instances: [{ id: 'instance-3', hostId: 'host-2' }],
      },
    ]);
    prisma.tx.host.findUnique
      .mockResolvedValueOnce({
        id: 'host-1',
        agent: null,
        serviceInstances: [],
        checks: [],
        agentInstallRequests: [],
        facts: [],
      })
      .mockResolvedValueOnce({
        id: 'host-2',
        agent: { id: 'agent-2' },
        serviceInstances: [],
        checks: [],
        agentInstallRequests: [],
        facts: [],
      });

    const result = await service.remove('user-1', 'integration-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tx.service.findMany).toHaveBeenCalledWith({
      where: { source: 'proxmox:integration-1' },
      select: {
        id: true,
        instances: {
          select: {
            id: true,
            hostId: true,
          },
        },
      },
    });
    expect(prisma.tx.service.deleteMany).toHaveBeenCalledWith({
      where: { source: 'proxmox:integration-1' },
    });
    expect(prisma.tx.integration.delete).toHaveBeenCalledWith({
      where: { id: 'integration-1' },
    });
    expect(prisma.tx.host.delete).toHaveBeenCalledWith({
      where: { id: 'host-1' },
    });
    expect(prisma.tx.host.delete).toHaveBeenCalledTimes(1);
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'integration.delete',
        targetType: 'integration',
        targetId: 'integration-1',
        resultJson: {
          source: 'proxmox:integration-1',
          deletedServiceCount: 2,
          deletedServiceInstanceCount: 3,
          deletedHostCount: 1,
        },
        success: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      integrationId: 'integration-1',
      deletedServiceCount: 2,
      deletedServiceInstanceCount: 3,
      deletedHostCount: 1,
    });
  });

  it('preserves candidate hosts that still have remaining related records', async () => {
    prisma.integration.findUnique.mockResolvedValue({
      id: 'integration-2',
      type: 'PROXMOX',
    });
    prisma.tx.service.findMany.mockResolvedValue([
      {
        id: 'service-a',
        instances: [{ id: 'instance-a', hostId: 'host-agent' }],
      },
      {
        id: 'service-b',
        instances: [{ id: 'instance-b', hostId: 'host-instance' }],
      },
      {
        id: 'service-c',
        instances: [{ id: 'instance-c', hostId: 'host-check' }],
      },
      {
        id: 'service-d',
        instances: [{ id: 'instance-d', hostId: 'host-request' }],
      },
      {
        id: 'service-e',
        instances: [{ id: 'instance-e', hostId: 'host-facts' }],
      },
    ]);
    prisma.tx.host.findUnique
      .mockResolvedValueOnce({
        id: 'host-agent',
        agent: { id: 'agent-1' },
        serviceInstances: [],
        checks: [],
        agentInstallRequests: [],
        facts: [],
      })
      .mockResolvedValueOnce({
        id: 'host-instance',
        agent: null,
        serviceInstances: [{ id: 'remaining-instance' }],
        checks: [],
        agentInstallRequests: [],
        facts: [],
      })
      .mockResolvedValueOnce({
        id: 'host-check',
        agent: null,
        serviceInstances: [],
        checks: [{ id: 'check-1' }],
        agentInstallRequests: [],
        facts: [],
      })
      .mockResolvedValueOnce({
        id: 'host-request',
        agent: null,
        serviceInstances: [],
        checks: [],
        agentInstallRequests: [{ id: 'request-1' }],
        facts: [],
      })
      .mockResolvedValueOnce({
        id: 'host-facts',
        agent: null,
        serviceInstances: [],
        checks: [],
        agentInstallRequests: [],
        facts: [{ id: 'fact-1' }],
      });

    const result = await service.remove('user-9', 'integration-2');

    expect(prisma.tx.host.delete).not.toHaveBeenCalled();
    expect(result.deletedHostCount).toBe(0);
  });

  it('fails with not found when the integration does not exist', async () => {
    prisma.integration.findUnique.mockResolvedValue(null);

    await expect(service.remove('user-1', 'missing-integration')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auditService.write).not.toHaveBeenCalled();
  });
});

describe('IntegrationsService.createOrUpdate', () => {
  const securityService = {
    encryptJson: vi.fn((value) => `encrypted:${JSON.stringify(value)}`),
    decryptJson: vi.fn(),
  };
  const eventsService = {
    emit: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let prisma: ReturnType<typeof createPrismaMock>;
  let service: IntegrationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createPrismaMock();
    service = new IntegrationsService(
      prisma as never,
      securityService as never,
      eventsService as never,
      auditService as never,
    );
  });

  it('creates a Proxmox integration from explicit fields and audits a sanitized payload', async () => {
    prisma.integration.create.mockResolvedValue({
      id: 'integration-3',
      name: 'Proxmox Lab',
      type: 'PROXMOX',
      enabled: true,
      config: {
        baseUrl: 'https://pve.local:8006',
        allowInsecureTls: true,
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

    const result = await service.createOrUpdate('user-1', {
      confirm: true,
      name: 'Proxmox Lab',
      enabled: true,
      baseUrl: 'https://pve.local:8006',
      apiTokenId: 'root@pam!dashboard',
      apiTokenSecret: 'super-secret',
      allowInsecureTls: true,
    });

    expect(prisma.integration.create).toHaveBeenCalledWith({
      data: {
        name: 'Proxmox Lab',
        type: 'PROXMOX',
        enabled: true,
        config: {
          baseUrl: 'https://pve.local:8006',
          allowInsecureTls: true,
        },
        credential: {
          create: {
            encryptedBlob:
              'encrypted:{"apiTokenId":"root@pam!dashboard","apiTokenSecret":"super-secret"}',
          },
        },
      },
      include: { credential: true },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'integration.upsert',
        paramsJson: {
          name: 'Proxmox Lab',
          baseUrl: 'https://pve.local:8006',
          allowInsecureTls: true,
          enabled: true,
          apiTokenId: 'root@pam!dashboard',
        },
        success: true,
      }),
    );
    expect(result).toMatchObject({
      id: 'integration-3',
      name: 'Proxmox Lab',
      type: 'PROXMOX',
      enabled: true,
      baseUrl: 'https://pve.local:8006',
      allowInsecureTls: true,
      apiTokenId: 'root@pam!dashboard',
      hasApiTokenSecret: true,
    });
  });

  it('preserves the existing secret when updating without a replacement secret', async () => {
    prisma.integration.findUnique.mockResolvedValue({
      id: 'integration-4',
      type: 'PROXMOX',
      credential: {
        encryptedBlob: 'encrypted-existing',
      },
    });
    securityService.decryptJson.mockReturnValue({
      apiTokenId: 'root@pam!dashboard',
      apiTokenSecret: 'current-secret',
    });
    prisma.integration.update.mockResolvedValue({
      id: 'integration-4',
      name: 'Proxmox Lab',
      type: 'PROXMOX',
      enabled: false,
      config: {
        baseUrl: 'https://pve.local:8006',
        allowInsecureTls: false,
      },
      credential: {
        encryptedBlob: 'encrypted-next',
      },
      lastSyncAt: null,
      lastStatus: 'ok',
      lastError: null,
      createdAt: new Date('2026-03-14T00:00:00.000Z'),
      updatedAt: new Date('2026-03-14T00:00:01.000Z'),
    });

    const result = await service.createOrUpdate('user-2', {
      confirm: true,
      id: 'integration-4',
      name: 'Proxmox Lab',
      enabled: false,
      baseUrl: 'https://pve.local:8006',
      apiTokenId: 'root@pam!dashboard',
      allowInsecureTls: false,
    });

    expect(securityService.encryptJson).toHaveBeenCalledWith({
      apiTokenId: 'root@pam!dashboard',
      apiTokenSecret: 'current-secret',
    });
    expect(result).toMatchObject({
      id: 'integration-4',
      enabled: false,
      apiTokenId: 'root@pam!dashboard',
      hasApiTokenSecret: true,
    });
  });
});

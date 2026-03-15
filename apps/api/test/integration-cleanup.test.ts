/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the integration cleanup test behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { deleteIntegrationWithAudit } from '../src/modules/integrations/integration-cleanup';

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
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    tx,
  };
}

describe('deleteIntegrationWithAudit', () => {
  it('reuses delete semantics for retired integrations and emits an audit row without a user actor', async () => {
    const prisma = createPrismaMock();
    const auditWriter = {
      write: vi.fn(),
    };

    prisma.tx.service.findMany.mockResolvedValue([
      {
        id: 'service-1',
        instances: [{ id: 'instance-1', hostId: 'host-1' }],
      },
    ]);
    prisma.tx.host.findUnique.mockResolvedValue({
      id: 'host-1',
      agent: null,
      serviceInstances: [],
      checks: [],
      agentInstallRequests: [],
      facts: [],
    });

    const result = await deleteIntegrationWithAudit(prisma, auditWriter, {
      integrationId: 'integration-retired-1',
      integrationType: 'UNIFI',
      action: 'integration.retire',
      paramsJson: {
        retiredType: 'UNIFI',
      },
    });

    expect(prisma.tx.service.findMany).toHaveBeenCalledWith({
      where: { source: 'unifi:integration-retired-1' },
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
      where: { source: 'unifi:integration-retired-1' },
    });
    expect(prisma.tx.integration.delete).toHaveBeenCalledWith({
      where: { id: 'integration-retired-1' },
    });
    expect(prisma.tx.host.delete).toHaveBeenCalledWith({
      where: { id: 'host-1' },
    });
    expect(auditWriter.write).toHaveBeenCalledWith({
      actorUserId: undefined,
      action: 'integration.retire',
      targetType: 'integration',
      targetId: 'integration-retired-1',
      paramsJson: {
        retiredType: 'UNIFI',
      },
      resultJson: {
        source: 'unifi:integration-retired-1',
        deletedServiceCount: 1,
        deletedServiceInstanceCount: 1,
        deletedHostCount: 1,
      },
      success: true,
    });
    expect(result).toEqual({
      ok: true,
      integrationId: 'integration-retired-1',
      deletedServiceCount: 1,
      deletedServiceInstanceCount: 1,
      deletedHostCount: 1,
    });
  });
});

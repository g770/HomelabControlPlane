/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the jobs test behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  processAlertsJob,
  processChecksJob,
  processCleanupJob,
  processIntegrationsJob,
  type CheckProbeDependencies,
} from '../src/jobs';
import type { WorkerPrismaClient } from '../src/prisma-contract';

/**
 * Creates prisma mock.
 */
function createPrismaMock() {
  return {
    check: {
      findMany: vi.fn(),
    },
    checkResult: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    event: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    alertRule: {
      findMany: vi.fn(),
    },
    alertEvent: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    host: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    service: {
      upsert: vi.fn(),
    },
    serviceInstance: {
      upsert: vi.fn(),
    },
    integration: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    hostFact: {
      deleteMany: vi.fn(),
    },
    aiMessage: {
      deleteMany: vi.fn(),
    },
  };
}

describe('processChecksJob', () => {
  it('creates check results and emits check.down events for failed checks', async () => {
    const prisma = createPrismaMock();
    prisma.check.findMany.mockResolvedValue([
      {
        id: 'check-http',
        hostId: 'host-1',
        name: 'HTTP check',
        type: 'HTTP',
        target: 'https://example.com',
        timeoutMs: 500,
        expectedStatus: 200,
        keyword: null,
      },
      {
        id: 'check-tcp',
        hostId: 'host-2',
        name: 'TCP check',
        type: 'TCP',
        target: '10.0.0.2:22',
        timeoutMs: 500,
        expectedStatus: null,
        keyword: null,
      },
    ]);

    const probes: CheckProbeDependencies = {
      runHttpCheck: vi.fn().mockResolvedValue({
        status: 'UP',
        latencyMs: 15,
        httpStatus: 200,
        errorMessage: null,
      }),
      runTcpCheck: vi.fn().mockResolvedValue({
        status: 'DOWN',
        latencyMs: 35,
        errorMessage: 'connection refused',
      }),
      runIcmpCheck: vi.fn(),
    };

    await processChecksJob(prisma as unknown as WorkerPrismaClient, probes);

    expect(prisma.checkResult.create).toHaveBeenCalledTimes(2);
    expect(prisma.event.create).toHaveBeenCalledTimes(1);
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'check.down',
          checkId: 'check-tcp',
        }),
      }),
    );
  });

  it('runs ICMP checks through the ICMP probe dependency', async () => {
    const prisma = createPrismaMock();
    prisma.check.findMany.mockResolvedValue([
      {
        id: 'check-icmp',
        hostId: 'host-3',
        name: 'ICMP check',
        type: 'ICMP',
        target: '10.0.0.3',
        timeoutMs: 500,
        expectedStatus: null,
        keyword: null,
      },
    ]);

    const probes: CheckProbeDependencies = {
      runHttpCheck: vi.fn(),
      runTcpCheck: vi.fn(),
      runIcmpCheck: vi.fn().mockResolvedValue({
        status: 'UP',
        latencyMs: 7,
        errorMessage: null,
      }),
    };

    await processChecksJob(prisma as unknown as WorkerPrismaClient, probes);

    expect(probes.runIcmpCheck).toHaveBeenCalledTimes(1);
    expect(prisma.checkResult.create).toHaveBeenCalledTimes(1);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });
});

describe('processAlertsJob', () => {
  it('is a no-op compatibility stub while alert evaluation lives in the API', async () => {
    const prisma = createPrismaMock();
    await expect(
      processAlertsJob(prisma as unknown as WorkerPrismaClient),
    ).resolves.toBeUndefined();
    expect(prisma.alertRule.findMany).not.toHaveBeenCalled();
    expect(prisma.alertEvent.upsert).not.toHaveBeenCalled();
    expect(prisma.alertEvent.updateMany).not.toHaveBeenCalled();
  });
});

describe('processIntegrationsJob', () => {
  it('requires APP_MASTER_KEY when default dependencies are used', async () => {
    const prisma = createPrismaMock();
    const previousMasterKey = process.env.APP_MASTER_KEY;

    delete process.env.APP_MASTER_KEY;

    try {
      await expect(processIntegrationsJob(prisma as unknown as WorkerPrismaClient)).rejects.toThrow(
        'APP_MASTER_KEY is required',
      );
    } finally {
      if (previousMasterKey === undefined) {
        delete process.env.APP_MASTER_KEY;
      } else {
        process.env.APP_MASTER_KEY = previousMasterKey;
      }
    }
  });

  it('syncs records and updates integration status to ok on success', async () => {
    const prisma = createPrismaMock();
    prisma.integration.findMany.mockResolvedValue([
      {
        id: 'integration-1',
        name: 'Proxmox DC',
        type: 'PROXMOX',
        config: { mock: true },
        credential: { encryptedBlob: 'blob' },
      },
    ]);
    prisma.integration.findUnique.mockResolvedValue({
      id: 'integration-1',
      enabled: true,
    });
    prisma.host.upsert.mockResolvedValue({ id: 'host-1', hostname: 'pve-node-1' });
    prisma.service.upsert.mockResolvedValue({ id: 'service-1', name: 'pve-qemu-vm100' });

    const decrypt = vi.fn().mockReturnValue({ apiToken: 'token' });
    const sync = vi.fn().mockResolvedValue([
      {
        hostName: 'pve-node-1',
        serviceName: 'pve-qemu-vm100',
        status: 'OK',
        tags: ['proxmox'],
      },
    ]);

    await processIntegrationsJob(prisma as unknown as WorkerPrismaClient, {
      decrypt,
      sync,
      masterKey: 'k',
      now: () => new Date('2026-03-02T00:00:00.000Z'),
    });

    expect(prisma.integration.findMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        type: 'PROXMOX',
      },
      include: { credential: true },
    });
    expect(decrypt).toHaveBeenCalledWith('k', 'blob');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(prisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'integration-1' },
        data: expect.objectContaining({ lastStatus: 'ok' }),
      }),
    );
    expect(prisma.event.create).toHaveBeenCalledTimes(1);
  });

  it('skips applying synced records when the integration disappears before reconciliation', async () => {
    const prisma = createPrismaMock();
    prisma.integration.findMany.mockResolvedValue([
      {
        id: 'integration-1',
        name: 'Proxmox DC',
        type: 'PROXMOX',
        config: { mock: true },
        credential: { encryptedBlob: 'blob' },
      },
    ]);
    prisma.integration.findUnique.mockResolvedValue(null);

    const decrypt = vi.fn().mockReturnValue({ apiToken: 'token' });
    const sync = vi.fn().mockResolvedValue([
      {
        hostName: 'pve-node-1',
        serviceName: 'pve-qemu-vm100',
        status: 'OK',
        tags: ['proxmox'],
      },
    ]);

    await processIntegrationsJob(prisma as unknown as WorkerPrismaClient, {
      decrypt,
      sync,
      masterKey: 'k',
      now: () => new Date('2026-03-02T00:00:00.000Z'),
    });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(prisma.host.upsert).not.toHaveBeenCalled();
    expect(prisma.service.upsert).not.toHaveBeenCalled();
    expect(prisma.serviceInstance.upsert).not.toHaveBeenCalled();
    expect(prisma.integration.update).not.toHaveBeenCalled();
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it('treats missing integration status updates as a benign delete race', async () => {
    const prisma = createPrismaMock();
    prisma.integration.findMany.mockResolvedValue([
      {
        id: 'integration-1',
        name: 'Proxmox DC',
        type: 'PROXMOX',
        config: { mock: true },
        credential: { encryptedBlob: 'blob' },
      },
    ]);
    prisma.integration.findUnique.mockResolvedValue({
      id: 'integration-1',
      enabled: true,
    });
    prisma.host.upsert.mockResolvedValue({ id: 'host-1', hostname: 'pve-node-1' });
    prisma.service.upsert.mockResolvedValue({ id: 'service-1', name: 'pve-qemu-vm100' });
    prisma.integration.update.mockRejectedValueOnce({ code: 'P2025' });

    const decrypt = vi.fn().mockReturnValue({ apiToken: 'token' });
    const sync = vi.fn().mockResolvedValue([
      {
        hostName: 'pve-node-1',
        serviceName: 'pve-qemu-vm100',
        status: 'OK',
        tags: ['proxmox'],
      },
    ]);

    await expect(
      processIntegrationsJob(prisma as unknown as WorkerPrismaClient, {
        decrypt,
        sync,
        masterKey: 'k',
        now: () => new Date('2026-03-02T00:00:00.000Z'),
      }),
    ).resolves.toBeUndefined();

    expect(prisma.integration.update).toHaveBeenCalledTimes(1);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it('records integration sync failures', async () => {
    const prisma = createPrismaMock();
    prisma.integration.findMany.mockResolvedValue([
      {
        id: 'integration-1',
        name: 'Broken Source',
        type: 'PROXMOX',
        config: {},
        credential: null,
      },
    ]);

    await processIntegrationsJob(prisma as unknown as WorkerPrismaClient, {
      masterKey: 'k',
      now: () => new Date('2026-03-02T00:00:00.000Z'),
    });

    expect(prisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'integration-1' },
        data: expect.objectContaining({
          lastStatus: 'error',
          lastError: 'Missing encrypted credentials',
        }),
      }),
    );
    expect(prisma.event.create).not.toHaveBeenCalled();
  });
});

describe('processCleanupJob', () => {
  it('deletes stale telemetry rows using cutoff', async () => {
    const prisma = createPrismaMock();

    await processCleanupJob(prisma as unknown as WorkerPrismaClient, 30);

    expect(prisma.checkResult.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.event.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.hostFact.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.aiMessage.deleteMany).toHaveBeenCalledTimes(1);
    const cutoff = prisma.checkResult.deleteMany.mock.calls[0]?.[0]?.where?.checkedAt?.lt;
    expect(cutoff).toBeInstanceOf(Date);
  });
});

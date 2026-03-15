/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the host identity test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileHostGroup,
  resolveCanonicalHostByIdentity,
  type HostIdentityRecord,
} from '../src/modules/common/host-identity';

/**
 * Builds host.
 */
function buildHost(overrides: Partial<HostIdentityRecord>): HostIdentityRecord {
  return {
    id: 'host-1',
    hostname: 'host-1',
    resolvedPrimaryIp: null,
    tags: [],
    status: 'OK',
    cpuPct: 0,
    memPct: 0,
    diskPct: 0,
    lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
    agentVersion: '1.0.0',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    agent: null,
    facts: [],
    ...overrides,
  };
}

/**
 * Creates identity store.
 */
function createIdentityStore(hosts: HostIdentityRecord[]) {
  const rows = new Map(hosts.map((host) => [host.id, { ...host }]));

  const store = {
    host: {
      findMany: vi.fn(async (args?: { where?: Record<string, any> }) => {
        const values = Array.from(rows.values());
        if (args?.where?.id) {
          return values.filter((host) => host.id === args.where?.id);
        }
        if (args?.where?.hostname?.equals) {
          const expected = String(args.where.hostname.equals).toLowerCase();
          return values.filter((host) => host.hostname.toLowerCase() === expected);
        }
        return values;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => rows.get(args.where.id) ?? null),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, any> }) => {
        const current = rows.get(args.where.id);
        if (!current) {
          throw new Error(`Host ${args.where.id} not found`);
        }
        const next = {
          ...current,
          ...args.data,
        };
        rows.set(args.where.id, next);
        return next;
      }),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const current = rows.get(args.where.id);
        if (!current) {
          throw new Error(`Host ${args.where.id} not found`);
        }
        rows.delete(args.where.id);
        return current;
      }),
    },
    hostFact: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    serviceInstance: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({ id: 'instance-1' }),
    },
    check: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    alertEvent: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    event: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agent: {
      update: vi.fn().mockResolvedValue({ id: 'agent-1' }),
    },
    agentInstallRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  return {
    rows,
    store,
  };
}

describe('host identity reconciliation', () => {
  const store = {
    host: {
      update: vi.fn(),
      delete: vi.fn(),
    },
    hostFact: {
      updateMany: vi.fn(),
    },
    serviceInstance: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    check: {
      updateMany: vi.fn(),
    },
    alertEvent: {
      updateMany: vi.fn(),
    },
    event: {
      updateMany: vi.fn(),
    },
    agent: {
      update: vi.fn(),
    },
    agentInstallRequest: {
      updateMany: vi.fn(),
    },
  };

  const auditService = {
    write: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store.serviceInstance.findMany.mockResolvedValue([]);
    store.serviceInstance.deleteMany.mockResolvedValue({ count: 0 });
    store.serviceInstance.update.mockResolvedValue({ id: 'instance-1' });
    store.host.update.mockResolvedValue({ id: 'host-1' });
    store.host.delete.mockResolvedValue({ id: 'host-2' });
  });

  it('skips automatic merge when multiple active agents share the same IP', async () => {
    const result = await reconcileHostGroup(
      store as any,
      auditService as any,
      [
        buildHost({
          id: 'host-1',
          agent: {
            id: 'agent-1',
            revokedAt: null,
            lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
          },
        }),
        buildHost({
          id: 'host-2',
          hostname: 'host-2',
          agent: {
            id: 'agent-2',
            revokedAt: null,
            lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
          },
        }),
      ],
      {
        primaryIp: '192.168.1.10',
      },
    );

    expect(result.skippedReason).toBe('multiple_active_agents');
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'host.reconcile.skip',
        success: true,
      }),
    );
    expect(store.host.update).not.toHaveBeenCalled();
    expect(store.host.delete).not.toHaveBeenCalled();
  });

  it('merges duplicate hosts, consolidates service instances, and audits the merge', async () => {
    store.serviceInstance.findMany.mockResolvedValueOnce([
      {
        id: 'instance-1',
        hostId: 'host-1',
        serviceId: 'service-1',
        name: 'plex@media',
        status: 'OK',
        endpoint: 'http://media:32400',
        metadata: { source: 'agent' },
        lastSeenAt: new Date('2026-03-02T00:00:00.000Z'),
        service: { name: 'plex' },
      },
      {
        id: 'instance-2',
        hostId: 'host-2',
        serviceId: 'service-1',
        name: 'plex@192.168.1.10',
        status: 'OK',
        endpoint: 'http://192.168.1.10:32400',
        metadata: { source: 'subnet' },
        lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
        service: { name: 'plex' },
      },
    ]);

    const result = await reconcileHostGroup(
      store as any,
      auditService as any,
      [
        buildHost({
          id: 'host-1',
          hostname: 'media',
          tags: ['nas'],
          agent: {
            id: 'agent-1',
            revokedAt: null,
            lastSeenAt: new Date('2026-03-02T00:00:00.000Z'),
          },
          facts: [{ id: 'fact-1', createdAt: new Date('2026-03-02T00:00:00.000Z'), snapshot: {} }],
        }),
        buildHost({
          id: 'host-2',
          hostname: '192.168.1.10',
          tags: ['discovered'],
          lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
          facts: [{ id: 'fact-2', createdAt: new Date('2026-03-01T00:00:00.000Z'), snapshot: {} }],
        }),
      ],
      {
        primaryIp: '192.168.1.10',
      },
    );

    expect(result).toEqual({
      canonicalHostId: 'host-1',
      mergedHostIds: ['host-2'],
    });
    expect(store.serviceInstance.deleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ['instance-2'],
        },
      },
    });
    expect(store.serviceInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'instance-1' },
        data: expect.objectContaining({
          hostId: 'host-1',
          name: 'plex@media',
        }),
      }),
    );
    expect(store.hostFact.updateMany).toHaveBeenCalledWith({
      where: { hostId: 'host-2' },
      data: { hostId: 'host-1' },
    });
    expect(store.host.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'host-1' },
        data: expect.objectContaining({
          hostname: 'media',
          tags: ['nas', 'discovered'],
        }),
      }),
    );
    expect(store.host.delete).toHaveBeenCalledWith({
      where: { id: 'host-2' },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'host.reconcile.merge',
        success: true,
      }),
    );
  });
});

describe('host identity lookup', () => {
  const auditService = {
    write: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores hostname-only matches when the existing host has a conflicting known IP', async () => {
    const { store } = createIdentityStore([
      buildHost({
        id: 'host-229',
        hostname: 'server-template',
        resolvedPrimaryIp: '192.168.10.229',
      }),
    ]);

    const resolved = await resolveCanonicalHostByIdentity(store as any, auditService as any, {
      hostname: 'server-template',
      primaryIp: '192.168.10.76',
    });

    expect(resolved).toBeNull();
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it('keeps hostname matches with no known IP eligible for IP-aware lookups', async () => {
    const { store } = createIdentityStore([
      buildHost({
        id: 'host-unknown-ip',
        hostname: 'server-template',
        resolvedPrimaryIp: null,
      }),
    ]);

    const resolved = await resolveCanonicalHostByIdentity(store as any, auditService as any, {
      hostname: 'server-template',
      primaryIp: '192.168.10.76',
    });

    expect(resolved).toMatchObject({
      id: 'host-unknown-ip',
      hostname: 'server-template',
    });
  });

  it('prefers the supplied hostId even when the stored IP has changed', async () => {
    const { store } = createIdentityStore([
      buildHost({
        id: 'host-bound',
        hostname: 'server-template',
        resolvedPrimaryIp: '192.168.10.229',
      }),
      buildHost({
        id: 'host-other',
        hostname: 'server-template',
        resolvedPrimaryIp: '192.168.10.88',
      }),
    ]);

    const resolved = await resolveCanonicalHostByIdentity(
      store as any,
      auditService as any,
      {
        hostId: 'host-bound',
        hostname: 'server-template',
        primaryIp: '192.168.10.76',
      },
      {
        preferredCanonicalHostId: 'host-bound',
      },
    );

    expect(resolved).toMatchObject({
      id: 'host-bound',
      hostname: 'server-template',
    });
  });

  it('still reconciles same-IP duplicates during IP-aware lookups', async () => {
    const { rows, store } = createIdentityStore([
      buildHost({
        id: 'host-agent',
        hostname: 'server-template',
        resolvedPrimaryIp: '192.168.10.76',
        agent: {
          id: 'agent-1',
          revokedAt: null,
          lastSeenAt: new Date('2026-03-03T00:00:00.000Z'),
        },
      }),
      buildHost({
        id: 'host-ip-alias',
        hostname: '192.168.10.76',
        resolvedPrimaryIp: null,
      }),
    ]);

    const resolved = await resolveCanonicalHostByIdentity(
      store as any,
      auditService as any,
      {
        hostname: 'server-template',
        primaryIp: '192.168.10.76',
      },
      {
        preferredCanonicalHostId: 'host-agent',
      },
    );

    expect(resolved).toMatchObject({
      id: 'host-agent',
      hostname: 'server-template',
    });
    expect(rows.has('host-agent')).toBe(true);
    expect(rows.has('host-ip-alias')).toBe(false);
    expect(store.host.delete).toHaveBeenCalledWith({
      where: { id: 'host-ip-alias' },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'host.reconcile.merge',
        success: true,
      }),
    );
  });
});

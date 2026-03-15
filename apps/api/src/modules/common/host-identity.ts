/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the host identity logic for the repository.
 */
import type { HealthStatus, Prisma } from '@prisma/client';
import { type PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const hostIdentitySelect = {
  id: true,
  hostname: true,
  resolvedPrimaryIp: true,
  tags: true,
  status: true,
  cpuPct: true,
  memPct: true,
  diskPct: true,
  lastSeenAt: true,
  agentVersion: true,
  createdAt: true,
  updatedAt: true,
  agent: {
    select: {
      id: true,
      revokedAt: true,
      lastSeenAt: true,
    },
  },
  facts: {
    orderBy: {
      createdAt: 'desc' as const,
    },
    take: 1,
    select: {
      id: true,
      createdAt: true,
      snapshot: true,
    },
  },
} satisfies Prisma.HostSelect;

/**
 * Describes the host identity record shape.
 */
export type HostIdentityRecord = Prisma.HostGetPayload<{
  select: typeof hostIdentitySelect;
}>;

type HostIdentityStore = Pick<
  PrismaService | Prisma.TransactionClient,
  | 'host'
  | 'hostFact'
  | 'serviceInstance'
  | 'check'
  | 'alertEvent'
  | 'event'
  | 'agent'
  | 'agentInstallRequest'
>;

type AuditWriter = Pick<AuditService, 'write'>;

/**
 * Describes the host identity lookup shape.
 */
export type HostIdentityLookup = {
  hostId?: string | null;
  hostname?: string | null;
  primaryIp?: string | null;
};

/**
 * Describes the host reconciliation options shape.
 */
export type HostReconciliationOptions = {
  actorUserId?: string;
  actorAgentId?: string;
  preferredCanonicalHostId?: string | null;
  primaryIp?: string | null;
};

/**
 * Describes the host reconciliation result shape.
 */
export type HostReconciliationResult = {
  canonicalHostId: string;
  mergedHostIds: string[];
  skippedReason?: string;
};

type ServiceInstanceRecord = {
  id: string;
  hostId: string | null;
  serviceId: string;
  name: string;
  status: HealthStatus;
  endpoint: string | null;
  metadata: Prisma.JsonValue | null;
  lastSeenAt: Date | null;
  service: {
    name: string;
  };
};

/**
 * Implements normalize host name.
 */
export function normalizeHostName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Implements normalize primary ip.
 */
export function normalizePrimaryIp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Implements extract resolved primary ip.
 */
export function extractResolvedPrimaryIp(snapshotValue: unknown): string | null {
  const snapshot = toRecord(snapshotValue);
  const network = toRecord(snapshot?.network);
  const direct = readString(network, ['primaryIp', 'ip', 'address']);
  if (direct) {
    return direct;
  }

  const interfaces = Array.isArray(network?.interfaces)
    ? network.interfaces
    : Array.isArray(network?.ifaces)
      ? network.ifaces
      : Array.isArray(network?.adapters)
        ? network.adapters
        : [];

  for (const entry of interfaces) {
    const record = toRecord(entry);
    const candidate = readString(record, ['ipv4', 'ip', 'address']);
    if (candidate) {
      return candidate;
    }
  }

  for (const entry of interfaces) {
    const record = toRecord(entry);
    const candidate = readString(record, ['ipv6']);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

/**
 * Checks whether ip like hostname.
 */
export function isIpLikeHostname(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) || /:/.test(trimmed);
}

/**
 * Implements find hosts by identity.
 */
export async function findHostsByIdentity(
  store: Pick<HostIdentityStore, 'host'>,
  lookup: HostIdentityLookup,
): Promise<HostIdentityRecord[]> {
  const hostId = lookup.hostId?.trim();
  const hostname = normalizeHostName(lookup.hostname);
  const primaryIp = normalizePrimaryIp(lookup.primaryIp);
  if (!hostId && !hostname && !primaryIp) {
    return [];
  }

  const [hostIdMatches, ipMatches, hostnameMatches] = await Promise.all([
    hostId
      ? store.host.findMany({
          where: { id: hostId },
          select: hostIdentitySelect,
        })
      : Promise.resolve([]),
    primaryIp
      ? store.host
          .findMany({
            select: hostIdentitySelect,
          })
          .then((hosts) =>
            hosts.filter((host) => {
              const hostIp = buildResolvedHostIp(host);
              if (
                hostIp &&
                hostIp.localeCompare(primaryIp, undefined, { sensitivity: 'accent' }) === 0
              ) {
                return true;
              }
              return (
                host.hostname.localeCompare(primaryIp, undefined, { sensitivity: 'accent' }) === 0
              );
            }),
          )
      : Promise.resolve([]),
    hostname
      ? store.host.findMany({
          where: {
            hostname: {
              equals: hostname,
              mode: 'insensitive',
            },
          },
          select: hostIdentitySelect,
        })
      : Promise.resolve([]),
  ]);

  if (!primaryIp) {
    return dedupeHosts([...hostIdMatches, ...hostnameMatches]);
  }

  const lockedHostIds = new Set([...hostIdMatches, ...ipMatches].map((host) => host.id));
  const compatibleHostnameMatches = hostnameMatches.filter((host) => {
    if (lockedHostIds.has(host.id)) {
      return true;
    }
    const hostIp = buildResolvedHostIp(host);
    if (!hostIp) {
      return true;
    }
    return hostIp.localeCompare(primaryIp, undefined, { sensitivity: 'accent' }) === 0;
  });

  return dedupeHosts([...hostIdMatches, ...ipMatches, ...compatibleHostnameMatches]);
}

/**
 * Implements choose canonical host.
 */
export function chooseCanonicalHost(
  hosts: HostIdentityRecord[],
  preferredCanonicalHostId?: string | null,
) {
  const preferredId = preferredCanonicalHostId?.trim() || null;
  return (
    [...hosts].sort((left, right) => compareHostsForCanonical(left, right, preferredId))[0] ?? null
  );
}

/**
 * Implements reconcile host group.
 */
export async function reconcileHostGroup(
  store: HostIdentityStore,
  auditService: AuditWriter,
  hosts: HostIdentityRecord[],
  options: HostReconciliationOptions = {},
): Promise<HostReconciliationResult> {
  const uniqueHosts = dedupeHosts(hosts);
  const canonical = chooseCanonicalHost(uniqueHosts, options.preferredCanonicalHostId);
  if (!canonical) {
    throw new Error('Host reconciliation requires at least one host');
  }

  const sources = uniqueHosts.filter((host) => host.id !== canonical.id);
  if (sources.length === 0) {
    return {
      canonicalHostId: canonical.id,
      mergedHostIds: [],
    };
  }

  const activeAgents = uniqueHosts.filter((host) => hasActiveAgent(host));
  if (activeAgents.length > 1) {
    const skippedReason = 'multiple_active_agents';
    await auditService.write({
      actorUserId: options.actorUserId,
      actorAgentId: options.actorAgentId,
      action: 'host.reconcile.skip',
      targetType: 'host',
      targetId: canonical.id,
      paramsJson: {
        preferredCanonicalHostId: options.preferredCanonicalHostId ?? null,
        primaryIp: normalizePrimaryIp(options.primaryIp),
        hostIds: uniqueHosts.map((host) => host.id),
        skippedReason,
      } as Prisma.InputJsonValue,
      success: true,
    });
    return {
      canonicalHostId: canonical.id,
      mergedHostIds: [],
      skippedReason,
    };
  }

  const mergedHostName = pickCanonicalHostname(uniqueHosts, canonical);
  const freshestHost = pickFreshestHost(uniqueHosts);
  const mergedTags = Array.from(
    new Set(
      uniqueHosts
        .flatMap((host) => host.tags)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  );

  await mergeServiceInstances(store, uniqueHosts, canonical.id, mergedHostName);

  for (const source of sources) {
    await store.hostFact.updateMany({
      where: { hostId: source.id },
      data: { hostId: canonical.id },
    });
    await store.check.updateMany({
      where: { hostId: source.id },
      data: { hostId: canonical.id },
    });
    await store.alertEvent.updateMany({
      where: { hostId: source.id },
      data: { hostId: canonical.id },
    });
    await store.event.updateMany({
      where: { hostId: source.id },
      data: { hostId: canonical.id },
    });
    await store.agentInstallRequest.updateMany({
      where: { targetHostId: source.id },
      data: { targetHostId: canonical.id },
    });

    if (source.agent && !canonical.agent) {
      await store.agent.update({
        where: { id: source.agent.id },
        data: { hostId: canonical.id },
      });
    }
  }

  await store.host.update({
    where: { id: canonical.id },
    data: {
      hostname: mergedHostName,
      tags: mergedTags,
      status: freshestHost.status,
      cpuPct: freshestHost.cpuPct,
      memPct: freshestHost.memPct,
      diskPct: freshestHost.diskPct,
      lastSeenAt: freshestHost.lastSeenAt,
      agentVersion: freshestHost.agentVersion,
    },
  });

  for (const source of sources) {
    await store.host.delete({
      where: { id: source.id },
    });
  }

  await auditService.write({
    actorUserId: options.actorUserId,
    actorAgentId: options.actorAgentId,
    action: 'host.reconcile.merge',
    targetType: 'host',
    targetId: canonical.id,
    paramsJson: {
      preferredCanonicalHostId: options.preferredCanonicalHostId ?? null,
      primaryIp: normalizePrimaryIp(options.primaryIp) ?? buildResolvedHostIp(canonical),
      hostIds: uniqueHosts.map((host) => host.id),
      canonicalHostId: canonical.id,
    } as Prisma.InputJsonValue,
    resultJson: {
      mergedHostIds: sources.map((host) => host.id),
      canonicalHostname: mergedHostName,
    } as Prisma.InputJsonValue,
    success: true,
  });

  return {
    canonicalHostId: canonical.id,
    mergedHostIds: sources.map((host) => host.id),
  };
}

/**
 * Implements resolve canonical host by identity.
 */
export async function resolveCanonicalHostByIdentity(
  store: HostIdentityStore,
  auditService: AuditWriter,
  lookup: HostIdentityLookup,
  options: HostReconciliationOptions = {},
): Promise<HostIdentityRecord | null> {
  const matches = await findHostsByIdentity(store, lookup);
  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  const mergePrimaryIp = normalizePrimaryIp(lookup.primaryIp ?? options.primaryIp);
  if (!mergePrimaryIp) {
    return chooseCanonicalHost(matches, options.preferredCanonicalHostId);
  }

  const result = await reconcileHostGroup(store, auditService, matches, {
    ...options,
    primaryIp: mergePrimaryIp,
  });

  return store.host.findUnique({
    where: { id: result.canonicalHostId },
    select: hostIdentitySelect,
  });
}

/**
 * Implements normalize service instances for host.
 */
export async function normalizeServiceInstancesForHost(
  store: Pick<HostIdentityStore, 'serviceInstance'>,
  hostId: string,
  hostName: string,
) {
  await normalizeServiceInstanceGroups(store, { hostId }, hostId, hostName);
}

/**
 * Builds resolved host ip.
 */
export function buildResolvedHostIp(host: {
  resolvedPrimaryIp?: string | null;
  facts?: Array<{ snapshot?: unknown }>;
}) {
  return host.resolvedPrimaryIp ?? extractResolvedPrimaryIp(host.facts?.[0]?.snapshot) ?? null;
}

/**
 * Implements compare hosts for canonical.
 */
function compareHostsForCanonical(
  left: HostIdentityRecord,
  right: HostIdentityRecord,
  preferredCanonicalHostId: string | null,
) {
  if (
    preferredCanonicalHostId &&
    left.id === preferredCanonicalHostId &&
    right.id !== preferredCanonicalHostId
  ) {
    return -1;
  }
  if (
    preferredCanonicalHostId &&
    right.id === preferredCanonicalHostId &&
    left.id !== preferredCanonicalHostId
  ) {
    return 1;
  }

  const leftActiveAgent = hasActiveAgent(left);
  const rightActiveAgent = hasActiveAgent(right);
  if (leftActiveAgent !== rightActiveAgent) {
    return leftActiveAgent ? -1 : 1;
  }

  const leftLastSeen = left.lastSeenAt?.getTime() ?? 0;
  const rightLastSeen = right.lastSeenAt?.getTime() ?? 0;
  if (leftLastSeen !== rightLastSeen) {
    return rightLastSeen - leftLastSeen;
  }

  const leftFactAt = left.facts[0]?.createdAt.getTime() ?? 0;
  const rightFactAt = right.facts[0]?.createdAt.getTime() ?? 0;
  if (leftFactAt !== rightFactAt) {
    return rightFactAt - leftFactAt;
  }

  const leftCreatedAt = left.createdAt.getTime();
  const rightCreatedAt = right.createdAt.getTime();
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  return left.id.localeCompare(right.id);
}

/**
 * Implements pick freshest host.
 */
function pickFreshestHost(hosts: HostIdentityRecord[]) {
  return [...hosts].sort((left, right) => {
    const leftLastSeen = left.lastSeenAt?.getTime() ?? 0;
    const rightLastSeen = right.lastSeenAt?.getTime() ?? 0;
    if (leftLastSeen !== rightLastSeen) {
      return rightLastSeen - leftLastSeen;
    }
    const leftFactAt = left.facts[0]?.createdAt.getTime() ?? 0;
    const rightFactAt = right.facts[0]?.createdAt.getTime() ?? 0;
    if (leftFactAt !== rightFactAt) {
      return rightFactAt - leftFactAt;
    }
    return right.updatedAt.getTime() - left.updatedAt.getTime();
  })[0]!;
}

/**
 * Implements pick canonical hostname.
 */
function pickCanonicalHostname(hosts: HostIdentityRecord[], canonical: HostIdentityRecord) {
  if (!isIpLikeHostname(canonical.hostname)) {
    return canonical.hostname.trim();
  }

  const namedHost = [...hosts]
    .filter((host) => !isIpLikeHostname(host.hostname))
    .sort((left, right) => compareHostsForCanonical(left, right, null))[0];

  return namedHost?.hostname.trim() || canonical.hostname.trim();
}

/**
 * Implements merge service instances.
 */
async function mergeServiceInstances(
  store: Pick<HostIdentityStore, 'serviceInstance'>,
  hosts: HostIdentityRecord[],
  canonicalHostId: string,
  canonicalHostName: string,
) {
  await normalizeServiceInstanceGroups(
    store,
    {
      hostIds: hosts.map((host) => host.id),
    },
    canonicalHostId,
    canonicalHostName,
  );
}

/**
 * Implements normalize service instance groups.
 */
async function normalizeServiceInstanceGroups(
  store: Pick<HostIdentityStore, 'serviceInstance'>,
  scope: {
    hostId?: string;
    hostIds?: string[];
  },
  canonicalHostId: string,
  canonicalHostName: string,
) {
  const where = scope.hostId
    ? { hostId: scope.hostId }
    : {
        hostId: {
          in: scope.hostIds ?? [],
        },
      };
  const instances = (await store.serviceInstance.findMany({
    where,
    select: {
      id: true,
      hostId: true,
      serviceId: true,
      name: true,
      status: true,
      endpoint: true,
      metadata: true,
      lastSeenAt: true,
      service: {
        select: {
          name: true,
        },
      },
    },
  })) as ServiceInstanceRecord[];

  const grouped = new Map<string, ServiceInstanceRecord[]>();
  for (const instance of instances) {
    const entries = grouped.get(instance.serviceId) ?? [];
    entries.push(instance);
    grouped.set(instance.serviceId, entries);
  }

  for (const group of grouped.values()) {
    const winner = [...group].sort((left, right) => {
      const leftSeen = left.lastSeenAt?.getTime() ?? 0;
      const rightSeen = right.lastSeenAt?.getTime() ?? 0;
      if (leftSeen !== rightSeen) {
        return rightSeen - leftSeen;
      }
      return left.id.localeCompare(right.id);
    })[0];

    if (!winner) {
      continue;
    }

    const desiredName = `${winner.service.name}@${canonicalHostName}`;
    const mergedEndpoint = pickNewestEndpoint(group);
    const mergedMetadata = mergeMetadataByFreshness(group);
    const mergedStatus = winner.status;
    const mergedLastSeenAt = group
      .map((instance) => instance.lastSeenAt?.getTime() ?? 0)
      .reduce((current, candidate) => Math.max(current, candidate), 0);
    const loserIds = group
      .filter((instance) => instance.id !== winner.id)
      .map((instance) => instance.id);

    if (loserIds.length > 0) {
      await store.serviceInstance.deleteMany({
        where: {
          id: {
            in: loserIds,
          },
        },
      });
    }

    await store.serviceInstance.update({
      where: { id: winner.id },
      data: {
        hostId: canonicalHostId,
        name: desiredName,
        status: mergedStatus,
        endpoint: mergedEndpoint,
        metadata: mergedMetadata as Prisma.InputJsonValue | undefined,
        lastSeenAt: mergedLastSeenAt > 0 ? new Date(mergedLastSeenAt) : null,
      },
    });
  }
}

/**
 * Implements pick newest endpoint.
 */
function pickNewestEndpoint(instances: ServiceInstanceRecord[]) {
  const withEndpoint = instances
    .filter(
      (instance) => typeof instance.endpoint === 'string' && instance.endpoint.trim().length > 0,
    )
    .sort((left, right) => {
      const leftSeen = left.lastSeenAt?.getTime() ?? 0;
      const rightSeen = right.lastSeenAt?.getTime() ?? 0;
      return rightSeen - leftSeen;
    });

  return withEndpoint[0]?.endpoint ?? null;
}

/**
 * Implements merge metadata by freshness.
 */
function mergeMetadataByFreshness(instances: ServiceInstanceRecord[]) {
  const ordered = [...instances].sort((left, right) => {
    const leftSeen = left.lastSeenAt?.getTime() ?? 0;
    const rightSeen = right.lastSeenAt?.getTime() ?? 0;
    return leftSeen - rightSeen;
  });

  const merged: Record<string, unknown> = {};
  for (const instance of ordered) {
    const record = toRecord(instance.metadata);
    if (!record) {
      continue;
    }
    Object.assign(merged, record);
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Implements dedupe hosts.
 */
function dedupeHosts(hosts: HostIdentityRecord[]) {
  const seen = new Set<string>();
  const deduped: HostIdentityRecord[] = [];
  for (const host of hosts) {
    if (seen.has(host.id)) {
      continue;
    }
    seen.add(host.id);
    deduped.push(host);
  }
  return deduped;
}

/**
 * Checks whether active agent.
 */
function hasActiveAgent(host: HostIdentityRecord) {
  return Boolean(host.agent && host.agent.revokedAt == null);
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Implements read string.
 */
function readString(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

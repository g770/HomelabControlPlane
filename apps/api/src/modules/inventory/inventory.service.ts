/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements inventory service business logic for the service layer.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { hostMetadataResponseSchema, type HostMetadataUpdate } from '@homelab/shared';
import { AlertEventStatus, CheckResultStatus, HealthStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildResolvedHostIp } from '../common/host-identity';

// Read-optimized inventory queries that power dashboard and host/service pages.
@Injectable()
/**
 * Implements the inventory service class.
 */
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // Aggregates home/dashboard data from hosts, alerts, checks, and event streams.
  async homeSummary() {
    const [hostsOnline, hostsOffline, activeAlerts, failingChecks, recentEvents, topConsumers] =
      await Promise.all([
        this.prisma.host.count({ where: { status: HealthStatus.OK } }),
        this.prisma.host.count({ where: { status: { not: HealthStatus.OK } } }),
        this.prisma.alertEvent.count({ where: { status: { not: AlertEventStatus.RESOLVED } } }),
        this.prisma.checkResult.count({ where: { status: CheckResultStatus.DOWN } }),
        this.prisma.event.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
        this.prisma.host.findMany({
          orderBy: [{ cpuPct: 'desc' }, { memPct: 'desc' }, { diskPct: 'desc' }],
          take: 10,
          select: {
            id: true,
            hostname: true,
            cpuPct: true,
            memPct: true,
            diskPct: true,
            status: true,
            lastSeenAt: true,
          },
        }),
      ]);

    const brokenHosts = await this.prisma.host.findMany({
      where: { status: { in: [HealthStatus.WARN, HealthStatus.CRIT] } },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    });

    const downChecks = await this.prisma.check.findMany({
      where: {
        results: {
          some: { status: CheckResultStatus.DOWN },
        },
      },
      include: {
        results: {
          orderBy: { checkedAt: 'desc' },
          take: 1,
        },
      },
      take: 20,
    });

    const alerts = await this.prisma.alertEvent.findMany({
      where: { status: { not: AlertEventStatus.RESOLVED } },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        rule: true,
        host: true,
        check: true,
      },
    });

    return {
      cards: {
        hostsOnline,
        hostsOffline,
        activeAlerts,
        failingChecks,
      },
      whatsBroken: {
        alerts,
        downChecks,
        offlineHosts: brokenHosts,
      },
      recentEvents,
      topConsumers,
    };
  }

  // Includes latest host fact so callers can derive point-in-time metadata like IP.
  async listHosts() {
    const hosts = await this.prisma.host.findMany({
      orderBy: { hostname: 'asc' },
      include: {
        agent: true,
        facts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            snapshot: true,
          },
        },
      },
    });

    return hosts.map((host) => {
      const latestFact = host.facts[0];
      return {
        ...host,
        hostType: deriveHostType(host.tags, latestFact?.snapshot),
        hostIp: buildResolvedHostIp(host),
      };
    });
  }

  // Hydrates a single host detail view with history, alerts, events, and services.
  async getHost(id: string) {
    const host = await this.prisma.host.findUnique({
      where: { id },
      include: {
        agent: true,
        facts: { orderBy: { createdAt: 'desc' }, take: 120 },
        checks: true,
        alertEvents: {
          orderBy: { startedAt: 'desc' },
          take: 20,
          include: { rule: true },
        },
        events: { orderBy: { createdAt: 'desc' }, take: 50 },
        serviceInstances: {
          include: { service: true },
          orderBy: { lastSeenAt: 'desc' },
        },
      },
    });

    if (!host) {
      throw new NotFoundException('Host not found');
    }

    const latestFact = host.facts[0];
    return {
      ...host,
      hostType: deriveHostType(host.tags, latestFact?.snapshot),
      hostIp: buildResolvedHostIp({ facts: host.facts }),
    };
  }

  /**
   * Handles update host metadata.
   */
  async updateHostMetadata(actorUserId: string, hostId: string, body: HostMetadataUpdate) {
    const host = await this.prisma.host.findUnique({
      where: { id: hostId },
      select: {
        id: true,
      },
    });
    if (!host) {
      throw new NotFoundException('Host not found');
    }

    const normalizedTags = applyHostTypeTag(normalizeHostTags(body.tags), body.hostType);
    const updated = await this.prisma.host.update({
      where: { id: hostId },
      data: {
        tags: normalizedTags,
      },
      select: {
        id: true,
        hostname: true,
        tags: true,
        updatedAt: true,
      },
    });

    await this.auditService.write({
      actorUserId,
      action: 'host.metadata.update',
      targetType: 'host',
      targetId: updated.id,
      paramsJson: {
        hostId: updated.id,
        hostName: updated.hostname,
        tags: updated.tags,
        hostType: body.hostType,
      } as Prisma.InputJsonValue,
      success: true,
    });

    return hostMetadataResponseSchema.parse({
      hostId: updated.id,
      hostName: updated.hostname,
      tags: updated.tags,
      hostType: deriveHostType(updated.tags, null),
      updatedAt: updated.updatedAt.toISOString(),
    });
  }

  // Returns discovered services and host bindings.
  async listServices() {
    return this.prisma.service.findMany({
      orderBy: { name: 'asc' },
      include: {
        instances: {
          include: {
            host: true,
          },
        },
      },
    });
  }

  // Loads a service detail view plus dependencies and monitoring state.
  async getService(id: string) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: {
        instances: { include: { host: true } },
        dependencies: {
          include: {
            dependsOnService: true,
          },
        },
        checks: true,
        alertEvents: {
          include: { rule: true },
          take: 20,
          orderBy: { startedAt: 'desc' },
        },
        events: {
          take: 50,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!service) {
      throw new NotFoundException('Service not found');
    }

    return service;
  }
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
function readString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

/**
 * Implements derive host type.
 */
function deriveHostType(
  tags: string[] | null | undefined,
  snapshotValue: unknown,
): 'CONTAINER' | 'MACHINE' {
  const normalizedTags = (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);

  if (normalizedTags.includes('container')) {
    return 'CONTAINER';
  }
  if (normalizedTags.includes('machine')) {
    return 'MACHINE';
  }

  if (containsRuntimeMarker(normalizedTags, containerRuntimeMarkers)) {
    return 'CONTAINER';
  }
  if (containsRuntimeMarker(normalizedTags, machineRuntimeMarkers)) {
    return 'MACHINE';
  }

  const snapshot = toRecord(snapshotValue);
  const system = toRecord(snapshot?.system);
  const os = toRecord(snapshot?.os);
  const runtime = toRecord(snapshot?.runtime) ?? toRecord(os?.runtime);

  const explicitContainer = readBoolean(runtime, ['isContainer']);
  if (explicitContainer === true) {
    return 'CONTAINER';
  }

  const runtimeHints = [
    readString(runtime, ['provider']),
    readString(runtime, ['type']),
    readString(runtime, ['environment']),
    readString(runtime, ['cgroupHint']),
    readString(system, ['virtualization']),
    readString(system, ['container']),
    readString(system, ['type']),
    readString(os, ['container']),
    readString(os, ['virtualization']),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());

  if (containsRuntimeMarker(runtimeHints, containerRuntimeMarkers)) {
    return 'CONTAINER';
  }
  if (containsRuntimeMarker(runtimeHints, machineRuntimeMarkers)) {
    return 'MACHINE';
  }

  return 'MACHINE';
}

const containerRuntimeMarkers = [
  'container',
  'docker',
  'podman',
  'lxc',
  'kubepods',
  'kube',
  'kubernetes',
  'containerd',
  'oci',
];
const machineRuntimeMarkers = [
  'machine',
  'baremetal',
  'physical',
  'vm',
  'qemu',
  'kvm',
  'hyperv',
  'xen',
  'proxmox',
];

/**
 * Implements contains runtime marker.
 */
function containsRuntimeMarker(values: string[], markers: string[]) {
  for (const value of values) {
    for (const marker of markers) {
      if (value.includes(marker)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Implements read boolean.
 */
function readBoolean(record: Record<string, unknown> | null, keys: string[]): boolean | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }
  }
  return null;
}

/**
 * Implements normalize host tags.
 */
function normalizeHostTags(tags: string[]) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) {
      continue;
    }
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Implements apply host type tag.
 */
function applyHostTypeTag(tags: string[], hostType: 'MACHINE' | 'CONTAINER') {
  const withoutTypeMarkers = tags.filter((tag) => {
    const normalized = tag.toLowerCase();
    return normalized !== 'machine' && normalized !== 'container';
  });
  const hostTypeTag = hostType === 'CONTAINER' ? 'container' : 'machine';
  return normalizeHostTags([...withoutTypeMarkers, hostTypeTag]);
}

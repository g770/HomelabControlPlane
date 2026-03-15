/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides utils helpers for the surrounding feature.
 */
import type { LinkWidgetMetricId, LinksDashboard } from '@/types/api';
import { readServiceInstanceState } from '@/lib/service-state';
import type { HostFact, HostServiceInstance, MetricPoint, ThroughputPoint } from './types';

const TELEMETRY_INTERVAL_MIN = 5;
const TELEMETRY_INTERVAL_MAX = 3600;

/**
 * Implements to record.
 */
export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Implements read string.
 */
export function readString(input: Record<string, unknown> | null, path: string[]) {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'string' && current.trim().length > 0) {
    return current.trim();
  }
  return null;
}

/**
 * Implements read number.
 */
export function readNumber(input: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (typeof current === 'number' && Number.isFinite(current)) {
    return current;
  }
  if (typeof current === 'string') {
    const parsed = Number(current);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

/**
 * Implements read host from endpoint.
 */
export function readHostFromEndpoint(endpoint: unknown) {
  if (typeof endpoint !== 'string') {
    return null;
  }
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Implements read host ip.
 */
export function readHostIp(snapshot: Record<string, unknown> | null) {
  const network = toRecord(snapshot?.network);
  const primary =
    readString(network, ['primaryIp']) ??
    readString(network, ['ip']) ??
    readString(network, ['address']);
  if (primary) {
    return primary;
  }

  const interfaces = Array.isArray(network?.interfaces)
    ? network.interfaces
    : Array.isArray(network?.ifaces)
      ? network.ifaces
      : Array.isArray(network?.adapters)
        ? network.adapters
        : [];

  for (const entry of interfaces) {
    const iface = toRecord(entry);
    const candidate =
      readString(iface, ['ipv4']) ?? readString(iface, ['ip']) ?? readString(iface, ['address']);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

/**
 * Implements clamp pct.
 */
export function clampPct(value: number) {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

/**
 * Implements metric value from snapshot.
 */
function metricValueFromSnapshot(snapshot: unknown, metric: 'cpu' | 'mem' | 'disk') {
  const source = toRecord(snapshot);
  if (!source) {
    return null;
  }

  if (metric === 'cpu') {
    return (
      /**
       * Handles read number.
       */
      readNumber(source, ['cpu', 'usage']) ??
      readNumber(source, ['cpu', 'usagePct']) ??
      readNumber(source, ['cpuPct'])
    );
  }

  if (metric === 'mem') {
    return (
      readNumber(source, ['memory', 'usagePct']) ??
      readNumber(source, ['memPct']) ??
      /**
       * Handles read number.
       */
      readNumber(source, ['memory', 'usage'])
    );
  }

  return (
    /**
     * Handles read number.
     */
    readNumber(source, ['storage', 'usagePct']) ??
    readNumber(source, ['diskPct']) ??
    readNumber(source, ['disk', 'usagePct'])
  );
}

/**
 * Implements read network interface counters.
 */
function readNetworkInterfaceCounters(snapshot: unknown) {
  const source = toRecord(snapshot);
  const network = toRecord(source?.network);
  const interfaces = Array.isArray(network?.interfaces)
    ? network.interfaces
    : Array.isArray(network?.ifaces)
      ? network.ifaces
      : Array.isArray(network?.adapters)
        ? network.adapters
        : [];

  const counters: Array<{ name: string; rxBytes: number; txBytes: number }> = [];
  for (const entry of interfaces) {
    const iface = toRecord(entry);
    const name =
      readString(iface, ['name']) ??
      readString(iface, ['interface']) ??
      readString(iface, ['iface']);
    const rxBytes =
      readNumber(iface ?? {}, ['rxBytes']) ??
      readNumber(iface ?? {}, ['rx']) ??
      readNumber(iface ?? {}, ['receiveBytes']);
    const txBytes =
      readNumber(iface ?? {}, ['txBytes']) ??
      readNumber(iface ?? {}, ['tx']) ??
      readNumber(iface ?? {}, ['transmitBytes']);
    if (!name || rxBytes === null || txBytes === null) {
      continue;
    }
    counters.push({ name, rxBytes, txBytes });
  }
  return counters;
}

/**
 * Implements read disk io counters.
 */
function readDiskIoCounters(snapshot: unknown) {
  const source = toRecord(snapshot);
  const storage = toRecord(source?.storage);
  const io = toRecord(storage?.io) ?? toRecord(storage?.diskIo) ?? storage;
  if (!io) {
    return null;
  }

  const readBytes =
    readNumber(io, ['readBytes']) ??
    readNumber(io, ['read_bytes']) ??
    readNumber(io, ['totalReadBytes']) ??
    readNumber(io, ['diskReadBytes']);
  const writeBytes =
    readNumber(io, ['writeBytes']) ??
    readNumber(io, ['write_bytes']) ??
    readNumber(io, ['totalWriteBytes']) ??
    readNumber(io, ['diskWriteBytes']);

  if (readBytes === null || writeBytes === null) {
    return null;
  }

  return { readBytes, writeBytes };
}

/**
 * Builds metric series.
 */
export function buildMetricSeries(facts: HostFact[], metric: 'cpu' | 'mem' | 'disk') {
  const points: MetricPoint[] = [];

  for (const fact of facts) {
    const createdAt = fact?.createdAt ? new Date(fact.createdAt).getTime() : NaN;
    const value = metricValueFromSnapshot(fact?.snapshot, metric);
    if (!Number.isFinite(createdAt) || value === null) {
      continue;
    }
    points.push({ at: createdAt, value: clampPct(value) });
  }

  points.sort((a, b) => a.at - b.at);
  return points;
}

/**
 * Builds network throughput series.
 */
export function buildNetworkThroughputSeries(facts: HostFact[]) {
  const samples = facts
    .map((fact) => {
      const at = fact?.createdAt ? new Date(fact.createdAt).getTime() : NaN;
      const interfaces = readNetworkInterfaceCounters(fact?.snapshot);
      let rxBytes = 0;
      let txBytes = 0;
      let found = false;
      for (const iface of interfaces) {
        rxBytes += iface.rxBytes;
        txBytes += iface.txBytes;
        found = true;
      }
      return {
        at,
        rxBytes: found ? rxBytes : null,
        txBytes: found ? txBytes : null,
      };
    })
    .filter(
      (
        sample,
      ): sample is {
        at: number;
        rxBytes: number;
        txBytes: number;
      } => Number.isFinite(sample.at) && sample.rxBytes !== null && sample.txBytes !== null,
    )
    .sort((a, b) => a.at - b.at);

  const points: ThroughputPoint[] = [];
  let previous: { at: number; rxBytes: number; txBytes: number } | null = null;
  for (const sample of samples) {
    if (!previous || sample.at <= previous.at) {
      previous = sample;
      continue;
    }

    const deltaSec = (sample.at - previous.at) / 1000;
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
      previous = sample;
      continue;
    }

    const rxRate = Math.max(0, sample.rxBytes - previous.rxBytes) / deltaSec;
    const txRate = Math.max(0, sample.txBytes - previous.txBytes) / deltaSec;
    if (Number.isFinite(rxRate) && Number.isFinite(txRate)) {
      points.push({
        at: sample.at,
        primary: rxRate,
        secondary: txRate,
      });
    }
    previous = sample;
  }

  return points;
}

/**
 * Builds disk io series.
 */
export function buildDiskIoSeries(facts: HostFact[]) {
  const samples = facts
    .map((fact) => {
      const at = fact?.createdAt ? new Date(fact.createdAt).getTime() : NaN;
      const counters = readDiskIoCounters(fact?.snapshot);
      return {
        at,
        readBytes: counters?.readBytes ?? null,
        writeBytes: counters?.writeBytes ?? null,
      };
    })
    .filter(
      (
        sample,
      ): sample is {
        at: number;
        readBytes: number;
        writeBytes: number;
      } => Number.isFinite(sample.at) && sample.readBytes !== null && sample.writeBytes !== null,
    )
    .sort((a, b) => a.at - b.at);

  const points: ThroughputPoint[] = [];
  let previous: { at: number; readBytes: number; writeBytes: number } | null = null;
  for (const sample of samples) {
    if (!previous || sample.at <= previous.at) {
      previous = sample;
      continue;
    }

    const deltaSec = (sample.at - previous.at) / 1000;
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
      previous = sample;
      continue;
    }

    const readRate = Math.max(0, sample.readBytes - previous.readBytes) / deltaSec;
    const writeRate = Math.max(0, sample.writeBytes - previous.writeBytes) / deltaSec;
    if (Number.isFinite(readRate) && Number.isFinite(writeRate)) {
      points.push({
        at: sample.at,
        primary: readRate,
        secondary: writeRate,
      });
    }
    previous = sample;
  }

  return points;
}

/**
 * Implements format range.
 */
export function formatRange(points: MetricPoint[]) {
  if (points.length === 0) {
    return 'No historical metric samples yet.';
  }
  if (points.length === 1) {
    const onlyPoint = points[0];
    if (!onlyPoint) {
      return 'No historical metric samples yet.';
    }
    return `1 sample at ${new Date(onlyPoint.at).toLocaleString()}`;
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) {
    return 'No historical metric samples yet.';
  }

  const first = new Date(firstPoint.at).toLocaleString();
  const last = new Date(lastPoint.at).toLocaleString();
  return `${points.length} samples from ${first} to ${last}`;
}

/**
 * Implements format range from throughput.
 */
export function formatRangeFromThroughput(points: ThroughputPoint[]) {
  if (points.length === 0) {
    return 'No historical throughput samples yet.';
  }
  if (points.length === 1) {
    const onlyPoint = points[0];
    if (!onlyPoint) {
      return 'No historical throughput samples yet.';
    }
    return `1 sample at ${new Date(onlyPoint.at).toLocaleString()}`;
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) {
    return 'No historical throughput samples yet.';
  }

  const first = new Date(firstPoint.at).toLocaleString();
  const last = new Date(lastPoint.at).toLocaleString();
  return `${points.length} samples from ${first} to ${last}`;
}

/**
 * Implements format bytes per second.
 */
export function formatBytesPerSecond(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return '-';
  }

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Implements metric label.
 */
export function metricLabel(metric: LinkWidgetMetricId) {
  if (metric === 'cpu') {
    return 'CPU';
  }
  if (metric === 'mem') {
    return 'Memory';
  }
  if (metric === 'disk') {
    return 'Disk';
  }
  if (metric === 'network') {
    return 'Network';
  }
  return 'Disk I/O';
}

/**
 * Parses interval input.
 */
export function parseIntervalInput(raw: string, label: string) {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} interval must be a whole number.`);
  }
  if (parsed < TELEMETRY_INTERVAL_MIN || parsed > TELEMETRY_INTERVAL_MAX) {
    throw new Error(
      `${label} interval must be between ${TELEMETRY_INTERVAL_MIN} and ${TELEMETRY_INTERVAL_MAX} seconds.`,
    );
  }
  return parsed;
}

/**
 * Implements to safe number.
 */
export function toSafeNumber(raw: string, fallback: number) {
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Implements normalize severity.
 */
export function normalizeSeverity(value: string) {
  const normalized = value.toUpperCase();
  if (normalized === 'ERROR' || normalized === 'CRIT') {
    return 'ERROR';
  }
  if (normalized === 'WARN' || normalized === 'WARNING') {
    return 'WARN';
  }
  return 'INFO';
}

/**
 * Implements event tone class.
 */
export function eventToneClass(severity: string) {
  const normalized = normalizeSeverity(severity);
  if (normalized === 'ERROR') {
    return 'text-red-500';
  }
  if (normalized === 'WARN') {
    return 'text-amber-500';
  }
  return 'text-emerald-500';
}

/**
 * Implements clone dashboard.
 */
export function cloneDashboard(dashboard: LinksDashboard): LinksDashboard {
  return JSON.parse(JSON.stringify(dashboard)) as LinksDashboard;
}

/**
 * Creates local id.
 */
export function createLocalId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Implements host service health statuses.
 */
export const hostServiceHealthStatuses = ['OK', 'WARN', 'CRIT', 'UNKNOWN'] as const;
/**
 * Describes the host service health status shape.
 */
export type HostServiceHealthStatus = (typeof hostServiceHealthStatuses)[number];

/**
 * Implements normalize service health status.
 */
export function normalizeServiceHealthStatus(value: unknown): HostServiceHealthStatus {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === 'OK' || normalized === 'WARN' || normalized === 'CRIT') {
    return normalized;
  }
  return 'UNKNOWN';
}

/**
 * Implements normalize service runtime state.
 */
export function normalizeServiceRuntimeState(value: string | null | undefined) {
  if (!value) {
    return 'n/a';
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : 'n/a';
}

/**
 * Implements list service runtime states.
 */
export function listServiceRuntimeStates(instances: HostServiceInstance[]) {
  const states = new Set<string>();
  for (const instance of instances) {
    states.add(normalizeServiceRuntimeState(readServiceInstanceState(instance)));
  }
  return Array.from(states.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Implements service search text.
 */
function serviceSearchText(instance: HostServiceInstance, runtimeState: string) {
  const serviceName = String(instance.service?.name ?? '');
  const instanceName = String(instance.name ?? '');
  const endpoint = typeof instance.endpoint === 'string' ? instance.endpoint : '';
  const status = normalizeServiceHealthStatus(instance.status);
  return [serviceName, instanceName, endpoint, runtimeState, status].join(' ').toLowerCase();
}

/**
 * Implements filter host service instances.
 */
export function filterHostServiceInstances(
  instances: HostServiceInstance[],
  input: {
    query: string;
    selectedHealth: ReadonlySet<HostServiceHealthStatus>;
    selectedRuntimeStates: ReadonlySet<string>;
  },
) {
  const search = input.query.trim().toLowerCase();
  return instances.filter((instance) => {
    const health = normalizeServiceHealthStatus(instance.status);
    if (input.selectedHealth.size > 0 && !input.selectedHealth.has(health)) {
      return false;
    }

    const runtimeState = normalizeServiceRuntimeState(readServiceInstanceState(instance));
    if (input.selectedRuntimeStates.size > 0 && !input.selectedRuntimeStates.has(runtimeState)) {
      return false;
    }

    if (!search) {
      return true;
    }
    return serviceSearchText(instance, runtimeState).includes(search);
  });
}

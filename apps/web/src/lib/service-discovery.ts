/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides service discovery helpers for the application.
 */
import type {
  ServiceDiscoveryCatalogResponse,
  ServiceDiscoveryRunHistorySummary,
  ServiceDiscoveryRunProgress,
} from '@/types/api';

type UnknownRecord = Record<string, unknown>;

/**
 * Describes the discovery console snapshot shape.
 */
export type DiscoveryConsoleSnapshot = {
  entries: Array<{
    seq: number;
    timestamp: string;
    level: string;
    message: string;
  }>;
  truncated: boolean;
  progress: ServiceDiscoveryRunProgress | null;
};

/**
 * Describes the service discovery finding row shape.
 */
export type ServiceDiscoveryFindingRow = {
  key: string;
  service: string;
  location: string;
  endpoint: string;
  confidence: string;
  source: string;
  evidence: string;
};

/**
 * Describes the service discovery findings snapshot shape.
 */
export type ServiceDiscoveryFindingsSnapshot = {
  rows: ServiceDiscoveryFindingRow[];
  warnings: string[];
  nonPersistedMessages: string[];
  isEmpty: boolean;
};

/**
 * Implements read discovery console snapshot.
 */
export function readDiscoveryConsoleSnapshot(
  summary: ServiceDiscoveryRunHistorySummary,
): DiscoveryConsoleSnapshot {
  const empty: DiscoveryConsoleSnapshot = {
    entries: [],
    truncated: false,
    progress: null,
  };
  const root = toRecord(summary);
  if (!root) {
    return empty;
  }

  const progressRecord = toRecord(root.progress);
  const progress = progressRecord
    ? {
        stage: readString(progressRecord.stage) ?? 'initializing',
        selectedHosts: readCounter(progressRecord.selectedHosts),
        scannedHosts: readCounter(progressRecord.scannedHosts),
        probes: readCounter(progressRecord.probes),
        subnetIpsProbed: readCounter(progressRecord.subnetIpsProbed),
        subnetIpsUnique: readCounter(progressRecord.subnetIpsUnique),
        subnetIpsReachable: readCounter(progressRecord.subnetIpsReachable),
        detections: readCounter(progressRecord.detections),
        upserts: readCounter(progressRecord.upserts),
        errors: readCounter(progressRecord.errors),
      }
    : null;

  const consoleRecord = toRecord(root.console);
  if (!consoleRecord) {
    return {
      ...empty,
      progress,
    };
  }

  const rawEntries = Array.isArray(consoleRecord.entries) ? consoleRecord.entries : [];
  const entries = rawEntries
    .map((entry, index) => {
      const record = toRecord(entry);
      if (!record) {
        return null;
      }
      const timestamp = readString(record.timestamp);
      const message = readString(record.message);
      if (!timestamp || !message) {
        return null;
      }

      return {
        seq: readCounter(record.seq, index + 1),
        timestamp,
        level: (readString(record.level) ?? 'INFO').toUpperCase(),
        message,
      };
    })
    .filter((entry): entry is DiscoveryConsoleSnapshot['entries'][number] => entry !== null);

  return {
    entries,
    truncated: Boolean(consoleRecord.truncated),
    progress,
  };
}

/**
 * Builds service discovery findings.
 */
export function buildServiceDiscoveryFindings(input: {
  summary: ServiceDiscoveryRunHistorySummary;
  catalog?: ServiceDiscoveryCatalogResponse | null;
}): ServiceDiscoveryFindingsSnapshot {
  const root = toRecord(input.summary);
  if (!root) {
    return {
      rows: [],
      warnings: [],
      nonPersistedMessages: [],
      isEmpty: true,
    };
  }

  const rows: ServiceDiscoveryFindingRow[] = [];
  const seenKeys = new Set<string>();
  const warnings: string[] = [];
  const nonPersistedMessages: string[] = [];
  const seenWarnings = new Set<string>();
  const signatureNameById = buildSignatureNameMap(input.catalog);

  /**
   * Implements add warning.
   */
  const addWarning = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    if (!seenWarnings.has(normalized)) {
      warnings.push(normalized);
      seenWarnings.add(normalized);
    }
    if (/not persisted/i.test(normalized)) {
      nonPersistedMessages.push(normalized);
    }
  };

  const summaryRecord = toRecord(root.summary);
  const summarySubnetRecord = summaryRecord ? toRecord(summaryRecord.subnet) : null;
  readStringArray(summarySubnetRecord?.warnings).forEach(addWarning);

  const hosts = readArray(root.hosts);
  for (const hostValue of hosts) {
    const host = toRecord(hostValue);
    if (!host) {
      continue;
    }
    const hostLabel = readString(host.hostName) ?? readString(host.hostId) ?? 'unknown host';

    for (const error of readStringArray(host.errors)) {
      addWarning(`${hostLabel}: ${error}`);
    }

    for (const detectionValue of readArray(host.detections)) {
      const detection = toRecord(detectionValue);
      if (!detection) {
        continue;
      }

      const signatureId = readString(detection.signatureId);
      if (!signatureId) {
        continue;
      }

      const endpoint = readString(detection.endpoint) ?? '-';
      const confidence = readOptionalConfidence(detection.confidence);
      const service = signatureNameById.get(signatureId.toLowerCase()) ?? signatureId;
      const row = {
        service,
        location: hostLabel,
        endpoint,
        confidence: formatDiscoveryConfidence(confidence),
        source: 'Host signature',
        evidence: formatHostEvidence(detection),
      };
      const key = dedupeKey(row);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      rows.push({
        key,
        ...row,
      });
    }
  }

  const subnetScans = readArray(root.subnet);
  for (const subnetValue of subnetScans) {
    const subnet = toRecord(subnetValue);
    if (!subnet) {
      continue;
    }
    const scannerHost =
      readString(subnet.hostName) ?? readString(subnet.hostId) ?? 'unknown scanner';
    for (const warning of readStringArray(subnet.warnings)) {
      addWarning(`${scannerHost}: ${warning}`);
    }

    for (const detectionValue of readArray(subnet.detections)) {
      const detection = toRecord(detectionValue);
      if (!detection) {
        continue;
      }
      const service =
        readString(detection.serviceName) ?? readString(detection.serviceId) ?? 'unknown service';
      const ip = readString(detection.ip);
      const hostname = readString(detection.hostname);
      const location = hostname && ip ? `${hostname} (${ip})` : (ip ?? scannerHost);
      const endpoint = readString(detection.endpoint) ?? '-';
      const confidence = readOptionalConfidence(detection.confidence);
      const source =
        (readString(detection.source) ?? 'signature').toLowerCase() === 'common-web'
          ? 'Subnet common-web'
          : 'Subnet signature';
      const row = {
        service,
        location,
        endpoint,
        confidence: formatDiscoveryConfidence(confidence),
        source,
        evidence: formatSubnetEvidence(detection.evidence),
      };
      const key = dedupeKey(row);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      rows.push({
        key,
        ...row,
      });
    }
  }

  for (const line of readDiscoveryConsoleSnapshot(input.summary).entries) {
    if (/not persisted/i.test(line.message)) {
      addWarning(line.message);
    }
  }

  return {
    rows,
    warnings,
    nonPersistedMessages: Array.from(new Set(nonPersistedMessages)),
    isEmpty: rows.length === 0,
  };
}

/**
 * Implements resolve discovery signature name.
 */
export function resolveDiscoverySignatureName(
  signatureId: string,
  catalog?: ServiceDiscoveryCatalogResponse | null,
): string {
  const normalizedId = signatureId.trim().toLowerCase();
  if (!normalizedId) {
    return signatureId;
  }
  return buildSignatureNameMap(catalog).get(normalizedId) ?? signatureId;
}

/**
 * Implements format discovery confidence.
 */
export function formatDiscoveryConfidence(confidence: number | null): string {
  if (confidence === null || !Number.isFinite(confidence)) {
    return 'n/a';
  }
  return `${Math.round(clamp(confidence, 0, 1) * 100)}%`;
}

/**
 * Builds signature name map.
 */
function buildSignatureNameMap(catalog?: ServiceDiscoveryCatalogResponse | null) {
  const map = new Map<string, string>();
  for (const service of catalog?.services ?? []) {
    map.set(service.id.toLowerCase(), service.name);
  }
  return map;
}

/**
 * Implements format host evidence.
 */
function formatHostEvidence(detection: UnknownRecord): string {
  const passive = toRecord(detection.passive) ?? {};
  const probeEvidence = toRecord(detection.probeEvidence) ?? {};
  const systemdCount = readStringArray(passive.systemdNames).length;
  const containerCount = readStringArray(passive.containerTexts).length;
  const processCount = readStringArray(passive.processTexts).length;
  const attempted = readCounter(probeEvidence.attempted, 0);
  const matched = readCounter(probeEvidence.matched, 0);

  const parts: string[] = [];
  if (systemdCount + containerCount + processCount > 0) {
    parts.push(
      `passive(systemd ${systemdCount}, container ${containerCount}, process ${processCount})`,
    );
  }
  if (attempted > 0 || matched > 0) {
    parts.push(`probes(${matched}/${Math.max(attempted, matched)} matched)`);
  }
  return parts.join('; ') || 'n/a';
}

/**
 * Implements format subnet evidence.
 */
function formatSubnetEvidence(value: unknown): string {
  const record = toRecord(value);
  if (!record) {
    return 'n/a';
  }
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(record)) {
    if (parts.length >= 4) {
      break;
    }
    const rendered = renderEvidenceValue(rawValue);
    if (!rendered) {
      continue;
    }
    parts.push(`${key}: ${rendered}`);
  }
  return parts.join(', ') || 'n/a';
}

/**
 * Renders the render evidence value view.
 */
function renderEvidenceValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const compact = value
      .map((entry) => renderEvidenceValue(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 3);
    return compact.length > 0 ? compact.join('|') : null;
  }
  return null;
}

/**
 * Implements dedupe key.
 */
function dedupeKey(row: { service: string; location: string; endpoint: string; source: string }) {
  return [row.service, row.location, row.endpoint, row.source]
    .map((value) => value.trim().toLowerCase())
    .join('|');
}

/**
 * Implements read counter.
 */
function readCounter(value: unknown, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.round(value));
}

/**
 * Implements read optional confidence.
 */
function readOptionalConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return clamp(value, 0, 1);
}

/**
 * Implements read array.
 */
function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Implements read string.
 */
function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Implements read string array.
 */
function readStringArray(value: unknown): string[] {
  return readArray(value)
    .map((entry) => readString(entry))
    .filter((entry): entry is string => entry !== null);
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

/**
 * Implements clamp.
 */
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

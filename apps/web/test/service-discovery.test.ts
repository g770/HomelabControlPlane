/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the service discovery test behavior.
 */
import { describe, expect, it } from 'vitest';
import type { ServiceDiscoveryCatalogResponse } from '@/types/api';
import {
  buildServiceDiscoveryFindings,
  formatDiscoveryConfidence,
  readDiscoveryConsoleSnapshot,
  resolveDiscoverySignatureName,
} from '@/lib/service-discovery';

const catalog: ServiceDiscoveryCatalogResponse = {
  id: 'global',
  source: 'HYBRID',
  expiresAt: '2026-02-25T12:00:00.000Z',
  lastError: null,
  serviceCount: 2,
  services: [
    {
      id: 'nginx',
      name: 'Nginx',
      aliases: ['web'],
      systemdHints: ['nginx'],
      containerHints: ['nginx'],
      processHints: ['nginx'],
      tags: ['web'],
      probes: [],
    },
    {
      id: 'jellyfin',
      name: 'Jellyfin',
      aliases: [],
      systemdHints: ['jellyfin'],
      containerHints: ['jellyfin'],
      processHints: ['jellyfin'],
      tags: ['media'],
      probes: [],
    },
  ],
};

describe('service discovery parser helpers', () => {
  it('parses host detections and maps signature ids to catalog names', () => {
    const snapshot = buildServiceDiscoveryFindings({
      catalog,
      summary: {
        summary: {
          hostCount: 1,
          probeCount: 2,
          detectedCount: 1,
          upsertCount: 1,
          errors: 0,
        },
        hosts: [
          {
            hostId: 'host-1',
            hostName: 'web-01',
            detections: [
              {
                signatureId: 'nginx',
                confidence: 0.92,
                endpoint: 'http://10.0.0.5:80',
                passive: {
                  systemdNames: ['nginx'],
                },
                probeEvidence: {
                  attempted: 2,
                  matched: 2,
                },
              },
            ],
            errors: [],
          },
        ],
      },
    });

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.service).toBe('Nginx');
    expect(snapshot.rows[0]?.location).toBe('web-01');
    expect(snapshot.rows[0]?.confidence).toBe('92%');
    expect(snapshot.rows[0]?.source).toBe('Host signature');
    expect(snapshot.rows[0]?.evidence).toContain('passive');
  });

  it('parses subnet detections with location, source, endpoint, and confidence', () => {
    const snapshot = buildServiceDiscoveryFindings({
      catalog,
      summary: {
        summary: {
          hostCount: 1,
          probeCount: 8,
          detectedCount: 2,
          upsertCount: 0,
          errors: 0,
          subnet: {
            scannerAgents: 1,
            cidrCount: 1,
            hostsScanned: 2,
            hostsReachable: 1,
            detections: 1,
            upserts: 0,
            warnings: [
              'Subnet detections were not persisted because discovery auto-upsert is disabled.',
            ],
          },
        },
        subnet: [
          {
            agentId: 'agent-1',
            hostId: 'host-1',
            hostName: 'scanner-1',
            cidrs: ['192.168.1.0/24'],
            hostsScanned: 2,
            hostsReachable: 1,
            warnings: [
              'Subnet detections were not persisted because discovery auto-upsert is disabled.',
            ],
            detections: [
              {
                ip: '192.168.1.20',
                hostname: 'media',
                serviceId: 'jellyfin',
                serviceName: 'Jellyfin',
                endpoint: 'http://192.168.1.20:8096',
                confidence: 0.88,
                source: 'common-web',
                tags: ['media'],
                evidence: {
                  port: 8096,
                  match: 'web signature',
                },
              },
            ],
          },
        ],
      },
    });

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.service).toBe('Jellyfin');
    expect(snapshot.rows[0]?.location).toBe('media (192.168.1.20)');
    expect(snapshot.rows[0]?.source).toBe('Subnet common-web');
    expect(snapshot.rows[0]?.confidence).toBe('88%');
    expect(snapshot.rows[0]?.endpoint).toBe('http://192.168.1.20:8096');
    expect(snapshot.rows[0]?.evidence).toContain('port: 8096');
    expect(snapshot.nonPersistedMessages.some((message) => message.includes('not persisted'))).toBe(
      true,
    );
  });

  it('deduplicates normalized findings rows', () => {
    const snapshot = buildServiceDiscoveryFindings({
      summary: {
        hosts: [
          {
            hostName: 'web-01',
            detections: [
              { signatureId: 'nginx', endpoint: 'http://10.0.0.5', confidence: 0.9 },
              { signatureId: 'nginx', endpoint: 'http://10.0.0.5', confidence: 0.9 },
            ],
          },
        ],
        subnet: [
          {
            hostName: 'scanner-1',
            detections: [
              {
                ip: '10.0.0.10',
                serviceName: 'Grafana',
                endpoint: 'http://10.0.0.10:3000',
                confidence: 0.8,
                source: 'signature',
              },
              {
                ip: '10.0.0.10',
                serviceName: 'Grafana',
                endpoint: 'http://10.0.0.10:3000',
                confidence: 0.8,
                source: 'signature',
              },
            ],
          },
        ],
      },
    });

    expect(snapshot.rows).toHaveLength(2);
  });

  it('handles missing or malformed payloads safely', () => {
    const findings = buildServiceDiscoveryFindings({
      summary: {
        hosts: [{ hostName: 'node-1', detections: [{ signatureId: 123 }] }],
        console: { entries: [{ timestamp: 123, message: 5 }] },
      },
    });
    const consoleSnapshot = readDiscoveryConsoleSnapshot({
      console: { entries: [{ timestamp: 123, message: 5 }] },
    });

    expect(findings.rows).toEqual([]);
    expect(findings.isEmpty).toBe(true);
    expect(consoleSnapshot.entries).toEqual([]);
  });

  it('formats confidence and empty-state outputs', () => {
    expect(formatDiscoveryConfidence(null)).toBe('n/a');
    expect(formatDiscoveryConfidence(-1)).toBe('0%');
    expect(formatDiscoveryConfidence(2)).toBe('100%');

    const findings = buildServiceDiscoveryFindings({
      summary: {
        hosts: [],
        subnet: [],
      },
    });
    expect(findings.isEmpty).toBe(true);
    expect(findings.rows).toEqual([]);
  });

  it('resolves signature names with fallback', () => {
    expect(resolveDiscoverySignatureName('nginx', catalog)).toBe('Nginx');
    expect(resolveDiscoverySignatureName('unknown-service', catalog)).toBe('unknown-service');
  });
});

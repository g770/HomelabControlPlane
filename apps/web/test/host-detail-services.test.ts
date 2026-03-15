/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the host detail services test behavior.
 */
import { describe, expect, it } from 'vitest';
import type { HostServiceInstance } from '../src/pages/host-detail/types';
import {
  filterHostServiceInstances,
  listServiceRuntimeStates,
  normalizeServiceHealthStatus,
  normalizeServiceRuntimeState,
} from '../src/pages/host-detail/utils';

const instances: HostServiceInstance[] = [
  {
    id: '1',
    name: 'nginx@host-a',
    status: 'OK',
    endpoint: 'http://10.0.0.5:80',
    metadata: { state: 'running' },
    service: { name: 'Nginx' },
  },
  {
    id: '2',
    name: 'postgres@host-a',
    status: 'WARN',
    endpoint: 'tcp://10.0.0.5:5432',
    metadata: { state: 'starting' },
    service: { name: 'PostgreSQL' },
  },
  {
    id: '3',
    name: 'worker@host-a',
    status: 'CRIT',
    endpoint: null,
    metadata: {},
    service: { name: 'Background Worker' },
  },
];

describe('host detail service helpers', () => {
  it('normalizes health and runtime values', () => {
    expect(normalizeServiceHealthStatus('ok')).toBe('OK');
    expect(normalizeServiceHealthStatus('warning')).toBe('UNKNOWN');
    expect(normalizeServiceRuntimeState(' Running ')).toBe('running');
    expect(normalizeServiceRuntimeState(undefined)).toBe('n/a');
  });

  it('lists runtime states including n/a fallback', () => {
    expect(listServiceRuntimeStates(instances)).toEqual(['n/a', 'running', 'starting']);
  });

  it('filters by search, health status, and runtime state', () => {
    const searchFiltered = filterHostServiceInstances(instances, {
      query: 'postgres',
      selectedHealth: new Set(),
      selectedRuntimeStates: new Set(),
    });
    expect(searchFiltered.map((item) => item.id)).toEqual(['2']);

    const healthFiltered = filterHostServiceInstances(instances, {
      query: '',
      selectedHealth: new Set(['CRIT']),
      selectedRuntimeStates: new Set(),
    });
    expect(healthFiltered.map((item) => item.id)).toEqual(['3']);

    const runtimeFiltered = filterHostServiceInstances(instances, {
      query: '',
      selectedHealth: new Set(),
      selectedRuntimeStates: new Set(['running']),
    });
    expect(runtimeFiltered.map((item) => item.id)).toEqual(['1']);

    const combinedFiltered = filterHostServiceInstances(instances, {
      query: '10.0.0.5',
      selectedHealth: new Set(['WARN']),
      selectedRuntimeStates: new Set(['starting']),
    });
    expect(combinedFiltered.map((item) => item.id)).toEqual(['2']);
  });
});

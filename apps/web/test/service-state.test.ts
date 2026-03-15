/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the service state test behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  readServiceInstanceState,
  runtimeStateBadgeStatus,
  serviceInstanceStateLabel,
  summarizeServiceInstanceStates,
} from '../src/lib/service-state';

describe('service state helpers', () => {
  it('reads and normalizes instance state from metadata', () => {
    expect(
      readServiceInstanceState({
        metadata: {
          state: ' Running ',
        },
      }),
    ).toBe('running');
  });

  it('returns null/label fallback when state is missing', () => {
    expect(readServiceInstanceState({ metadata: {} })).toBeNull();
    expect(serviceInstanceStateLabel({ metadata: {} })).toBe('n/a');
    expect(serviceInstanceStateLabel(null)).toBe('n/a');
  });

  it('summarizes states with counts and n/a fallback ordering', () => {
    const summary = summarizeServiceInstanceStates([
      { metadata: { state: 'running' } },
      { metadata: { state: 'running' } },
      { metadata: { state: 'exited' } },
      { metadata: {} },
    ]);

    expect(summary).toBe('running:2, exited:1, n/a:1');
  });

  it('limits summary to top three states and reports overflow', () => {
    const summary = summarizeServiceInstanceStates([
      { metadata: { state: 'alpha' } },
      { metadata: { state: 'beta' } },
      { metadata: { state: 'gamma' } },
      { metadata: { state: 'delta' } },
      { metadata: {} },
    ]);

    expect(summary).toBe('alpha:1, beta:1, delta:1, +2 more');
  });

  it('returns n/a when instance list is empty', () => {
    expect(summarizeServiceInstanceStates([])).toBe('n/a');
  });

  it('maps runtime states to health badge statuses', () => {
    expect(runtimeStateBadgeStatus('running')).toBe('OK');
    expect(runtimeStateBadgeStatus('starting')).toBe('WARN');
    expect(runtimeStateBadgeStatus('failed')).toBe('CRIT');
    expect(runtimeStateBadgeStatus('custom-state')).toBe('UNKNOWN');
    expect(runtimeStateBadgeStatus(null)).toBe('UNKNOWN');
  });
});

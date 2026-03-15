/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the service discovery scoring test behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  computeDiscoveryScore,
  computePassiveScore,
  computeProbeScore,
} from '../src/modules/service-discovery/service-discovery.scoring';

describe('service discovery scoring', () => {
  it('computes passive score from evidence categories', () => {
    const passive = computePassiveScore({
      aliasMatches: ['jenkins'],
      systemdMatches: ['jenkins.service'],
      containerMatches: [],
      processMatches: [],
    });

    expect(passive).toBeGreaterThan(0.4);
    expect(passive).toBeLessThanOrEqual(1);
  });

  it('computes probe score as matched ratio', () => {
    expect(computeProbeScore({ attempted: 0, matched: 0 })).toBe(0);
    expect(computeProbeScore({ attempted: 4, matched: 1 })).toBe(0.25);
    expect(computeProbeScore({ attempted: 4, matched: 10 })).toBe(1);
  });

  it('combines passive and probe evidence into confidence', () => {
    const score = computeDiscoveryScore({
      passive: {
        aliasMatches: ['jenkins'],
        systemdMatches: ['jenkins.service'],
        containerMatches: ['jenkins/jenkins'],
        processMatches: ['java -jar jenkins.war'],
      },
      probe: {
        attempted: 2,
        matched: 2,
      },
    });

    expect(score.passiveScore).toBe(1);
    expect(score.probeScore).toBe(1);
    expect(score.confidence).toBe(1);
  });
});

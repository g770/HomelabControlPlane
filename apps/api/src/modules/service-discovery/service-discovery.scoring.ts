/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the service discovery scoring logic for the repository.
 */
/**
 * Describes the passive evidence shape.
 */
export type PassiveEvidence = {
  aliasMatches: string[];
  systemdMatches: string[];
  containerMatches: string[];
  processMatches: string[];
};

/**
 * Describes the probe evidence shape.
 */
export type ProbeEvidence = {
  attempted: number;
  matched: number;
};

/**
 * Describes the discovery score shape.
 */
export type DiscoveryScore = {
  passiveScore: number;
  probeScore: number;
  confidence: number;
};

const PASSIVE_WEIGHTS = {
  alias: 0.2,
  systemd: 0.3,
  container: 0.25,
  process: 0.25,
} as const;

const PASSIVE_MAX =
  PASSIVE_WEIGHTS.alias +
  PASSIVE_WEIGHTS.systemd +
  PASSIVE_WEIGHTS.container +
  PASSIVE_WEIGHTS.process;

/**
 * Checks whether match.
 */
function hasMatch(values: string[]) {
  return values.length > 0;
}

/**
 * Implements clamp.
 */
function clamp(value: number, min: number, max: number) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Implements compute passive score.
 */
export function computePassiveScore(evidence: PassiveEvidence) {
  let score = 0;
  if (hasMatch(evidence.aliasMatches)) {
    score += PASSIVE_WEIGHTS.alias;
  }
  if (hasMatch(evidence.systemdMatches)) {
    score += PASSIVE_WEIGHTS.systemd;
  }
  if (hasMatch(evidence.containerMatches)) {
    score += PASSIVE_WEIGHTS.container;
  }
  if (hasMatch(evidence.processMatches)) {
    score += PASSIVE_WEIGHTS.process;
  }

  if (PASSIVE_MAX <= 0) {
    return 0;
  }
  return clamp(score / PASSIVE_MAX, 0, 1);
}

/**
 * Implements compute probe score.
 */
export function computeProbeScore(probe: ProbeEvidence) {
  if (probe.attempted <= 0) {
    return 0;
  }
  return clamp(probe.matched / probe.attempted, 0, 1);
}

/**
 * Implements compute discovery score.
 */
export function computeDiscoveryScore(input: {
  passive: PassiveEvidence;
  probe: ProbeEvidence;
  passiveWeight?: number;
  probeWeight?: number;
}): DiscoveryScore {
  const passiveWeight = clamp(input.passiveWeight ?? 0.6, 0, 1);
  const probeWeight = clamp(input.probeWeight ?? 0.4, 0, 1);
  const weightTotal = passiveWeight + probeWeight;
  const normalizedPassiveWeight = weightTotal > 0 ? passiveWeight / weightTotal : 0.6;
  const normalizedProbeWeight = weightTotal > 0 ? probeWeight / weightTotal : 0.4;

  const passiveScore = computePassiveScore(input.passive);
  const probeScore = computeProbeScore(input.probe);
  const confidence = clamp(
    passiveScore * normalizedPassiveWeight + probeScore * normalizedProbeWeight,
    0,
    1,
  );

  return {
    passiveScore,
    probeScore,
    confidence,
  };
}

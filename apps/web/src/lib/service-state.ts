/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides service state helpers for the application.
 */
/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

const healthyRuntimeStates = new Set(['running', 'active', 'listening', 'up']);
const warningRuntimeStates = new Set([
  'starting',
  'activating',
  'reloading',
  'deactivating',
  'stopping',
  'paused',
]);
const criticalRuntimeStates = new Set([
  'failed',
  'dead',
  'exited',
  'inactive',
  'error',
  'crashed',
  'unhealthy',
]);

/**
 * Implements read service instance state.
 */
export function readServiceInstanceState(instance: unknown): string | null {
  const instanceRecord = toRecord(instance);
  const metadata = toRecord(instanceRecord?.metadata);
  const rawState = metadata?.state;
  if (typeof rawState !== 'string') {
    return null;
  }
  const trimmed = rawState.trim().toLowerCase();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

/**
 * Implements service instance state label.
 */
export function serviceInstanceStateLabel(instance: unknown) {
  return readServiceInstanceState(instance) ?? 'n/a';
}

/**
 * Implements runtime state badge status.
 */
export function runtimeStateBadgeStatus(
  state: string | null | undefined,
): 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN' {
  if (!state) {
    return 'UNKNOWN';
  }

  const normalized = state.trim().toLowerCase();
  if (!normalized) {
    return 'UNKNOWN';
  }

  if (healthyRuntimeStates.has(normalized)) {
    return 'OK';
  }
  if (warningRuntimeStates.has(normalized)) {
    return 'WARN';
  }
  if (criticalRuntimeStates.has(normalized)) {
    return 'CRIT';
  }
  return 'UNKNOWN';
}

/**
 * Implements summarize service instance states.
 */
export function summarizeServiceInstanceStates(instances: unknown[]) {
  if (!Array.isArray(instances) || instances.length === 0) {
    return 'n/a';
  }

  const counts = new Map<string, number>();
  for (const instance of instances) {
    const state = serviceInstanceStateLabel(instance);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  const entries = Array.from(counts.entries()).sort((a, b) => {
    if (a[0] === 'n/a' && b[0] !== 'n/a') {
      return 1;
    }
    if (b[0] === 'n/a' && a[0] !== 'n/a') {
      return -1;
    }
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });

  const visible = entries.slice(0, 3).map(([state, count]) => `${state}:${count}`);
  if (entries.length > 3) {
    visible.push(`+${entries.length - 3} more`);
  }
  return visible.join(', ');
}

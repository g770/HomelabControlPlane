/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides time helpers for the application.
 */
/**
 * Implements format time ago.
 */
export function formatTimeAgo(value: string | undefined, nowValue: Date = new Date()) {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const diffMs = nowValue.getTime() - parsed.getTime();
  const future = diffMs < 0;
  const absSeconds = Math.max(1, Math.floor(Math.abs(diffMs) / 1000));

  if (absSeconds < 60) {
    return future
      ? `in ${absSeconds} second${absSeconds === 1 ? '' : 's'}`
      : `${absSeconds} second${absSeconds === 1 ? '' : 's'} ago`;
  }

  const absMinutes = Math.floor(absSeconds / 60);
  if (absMinutes < 60) {
    return future
      ? `in ${absMinutes} min${absMinutes === 1 ? '' : 's'}`
      : `${absMinutes} min${absMinutes === 1 ? '' : 's'} ago`;
  }

  const absHours = Math.floor(absMinutes / 60);
  if (absHours < 24) {
    return future
      ? `in ${absHours} hour${absHours === 1 ? '' : 's'}`
      : `${absHours} hour${absHours === 1 ? '' : 's'} ago`;
  }

  const absDays = Math.floor(absHours / 24);
  return future
    ? `in ${absDays} day${absDays === 1 ? '' : 's'}`
    : `${absDays} day${absDays === 1 ? '' : 's'} ago`;
}

/**
 * Implements format timestamp.
 */
export function formatTimestamp(value: string | undefined) {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

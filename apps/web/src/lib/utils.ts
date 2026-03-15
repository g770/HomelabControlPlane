/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides utils helpers for the surrounding feature.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Implements cn.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Implements health color map.
 */
export const healthColorMap: Record<string, string> = {
  OK: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  WARN: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  CRIT: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  UNKNOWN: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

/**
 * Implements resolve api base url.
 */
function resolveApiBaseUrl() {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configuredBaseUrl && configuredBaseUrl.length > 0) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:4000';
  }

  const inferredApiUrl = new URL(window.location.origin);
  inferredApiUrl.port = '4000';
  return inferredApiUrl.origin;
}

/**
 * Implements api base url.
 */
export const apiBaseUrl = resolveApiBaseUrl();

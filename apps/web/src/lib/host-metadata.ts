/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides host metadata helpers for the application.
 */
/**
 * Describes the host type shape.
 */
export type HostType = 'MACHINE' | 'CONTAINER';

/**
 * Implements max host tag count.
 */
export const maxHostTagCount = 32;
/**
 * Implements max host tag length.
 */
export const maxHostTagLength = 40;
const hostTagPattern = /^[a-zA-Z0-9._:-]+$/;

/**
 * Parses and validate host tags.
 */
export function parseAndValidateHostTags(input: string) {
  const tags = normalizeHostTags(input.split(','));
  if (tags.length > maxHostTagCount) {
    throw new Error(`No more than ${maxHostTagCount} tags are allowed.`);
  }
  for (const tag of tags) {
    if (tag.length > maxHostTagLength) {
      throw new Error(`Tag "${tag}" is too long (max ${maxHostTagLength} characters).`);
    }
    if (!hostTagPattern.test(tag)) {
      throw new Error(`Tag "${tag}" contains invalid characters.`);
    }
  }
  return tags;
}

/**
 * Implements normalize host tags.
 */
export function normalizeHostTags(tags: string[]) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Parses host type input.
 */
export function parseHostTypeInput(input: string): HostType {
  const normalized = input.trim().toUpperCase();
  if (normalized === 'MACHINE') {
    return 'MACHINE';
  }
  if (normalized === 'CONTAINER') {
    return 'CONTAINER';
  }
  throw new Error('Host type must be "machine" or "container".');
}

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides discovery subnets helpers for the application.
 */
const ipv4CidrPattern = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;

/**
 * Parses discovery subnet input.
 */
export function parseDiscoverySubnetInput(text: string) {
  const seen = new Set<string>();
  const subnets: string[] = [];
  const invalid: string[] = [];
  const entries = text
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (!ipv4CidrPattern.test(entry)) {
      invalid.push(entry);
      continue;
    }

    const [ipPart] = entry.split('/');
    const octets = ipPart?.split('.') ?? [];
    const validOctets =
      octets.length === 4 &&
      octets.every((octet) => {
        if (!/^\d{1,3}$/.test(octet)) {
          return false;
        }
        const parsed = Number(octet);
        return parsed >= 0 && parsed <= 255;
      });
    if (!validOctets) {
      invalid.push(entry);
      continue;
    }

    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    subnets.push(entry);
    if (subnets.length >= 128) {
      break;
    }
  }

  return { subnets, invalid };
}

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the discovery subnets test behavior.
 */
import { describe, expect, it } from 'vitest';
import { parseDiscoverySubnetInput } from '@/lib/discovery-subnets';

describe('parseDiscoverySubnetInput', () => {
  it('parses, normalizes, and deduplicates cidrs', () => {
    const parsed = parseDiscoverySubnetInput('192.168.1.0/24, 10.0.0.0/24\n192.168.1.0/24');
    expect(parsed.subnets).toEqual(['192.168.1.0/24', '10.0.0.0/24']);
    expect(parsed.invalid).toEqual([]);
  });

  it('collects invalid cidrs', () => {
    const parsed = parseDiscoverySubnetInput('192.168.1.\n300.10.0.0/24\n10.0.0.0/33\n10.0.0.0/24');
    expect(parsed.subnets).toEqual(['10.0.0.0/24']);
    expect(parsed.invalid).toEqual(['192.168.1.', '300.10.0.0/24', '10.0.0.0/33']);
  });

  it('caps subnet count at 128 entries', () => {
    const cidrs = Array.from({ length: 140 }, (_, index) => `10.0.${index}.0/24`).join('\n');
    const parsed = parseDiscoverySubnetInput(cidrs);
    expect(parsed.subnets).toHaveLength(128);
    expect(parsed.invalid).toHaveLength(0);
  });
});

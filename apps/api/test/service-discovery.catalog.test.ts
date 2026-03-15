/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the service discovery catalog test behavior.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_DISCOVERY_SIGNATURES } from '../src/modules/service-discovery/service-discovery.catalog';

describe('service discovery catalog', () => {
  it('does not include retired UniFi or Synology signatures', () => {
    const ids = BUILTIN_DISCOVERY_SIGNATURES.map((signature) => signature.id);

    expect(ids).not.toContain('unifi');
    expect(ids).not.toContain('synology-dsm');
  });
});

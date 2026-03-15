/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the common security service test behavior.
 */
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { SecurityService } from '../src/modules/common/security.service';

describe('SecurityService', () => {
  const configService = {
    getOrThrow: vi.fn().mockReturnValue('unit-test-master-key'),
  } as unknown as ConfigService;

  it('hashes tokens deterministically', () => {
    const service = new SecurityService(configService);

    const hashA = service.hashToken('token-1');
    const hashB = service.hashToken('token-1');
    const hashC = service.hashToken('token-2');

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
    expect(hashA).toHaveLength(64);
  });

  it('compares strings in constant time when lengths match', () => {
    const service = new SecurityService(configService);

    expect(service.constantTimeEquals('same-value', 'same-value')).toBe(true);
    expect(service.constantTimeEquals('same-value', 'different')).toBe(false);
    expect(service.constantTimeEquals('short', 'longer')).toBe(false);
  });

  it('roundtrips encrypted JSON payloads', () => {
    const service = new SecurityService(configService);
    const payload = {
      token: 'secret-token',
      nested: {
        role: 'operator',
      },
      flags: [1, 2, 3],
    };

    const encrypted = service.encryptJson(payload);
    const decrypted = service.decryptJson<typeof payload>(encrypted);

    expect(typeof encrypted).toBe('string');
    expect(decrypted).toEqual(payload);
  });
});

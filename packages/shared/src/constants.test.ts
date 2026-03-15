/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the constants test behavior.
 */
import { describe, expect, it } from 'vitest';
import { READ_ONLY_TOOLS, SENSITIVE_READ_TOOLS, WRITE_TOOLS } from './constants';

describe('tool policy constants', () => {
  it('keeps read/write sets disjoint', () => {
    const overlap = Array.from(WRITE_TOOLS).filter((tool) => READ_ONLY_TOOLS.has(tool));
    expect(overlap).toEqual([]);
  });

  it('marks sensitive read tools as read-only', () => {
    const missingFromReadOnly = Array.from(SENSITIVE_READ_TOOLS).filter(
      (tool) => !READ_ONLY_TOOLS.has(tool),
    );
    expect(missingFromReadOnly).toEqual([]);
  });

  it('contains known high-impact write tools', () => {
    expect(WRITE_TOOLS.has('host.reboot')).toBe(true);
    expect(WRITE_TOOLS.has('compose.redeploy')).toBe(true);
  });
});

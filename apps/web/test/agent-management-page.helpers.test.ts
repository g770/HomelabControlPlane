/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the agent management page helpers test behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildMcpAdvertiseUrl, defaultBrowserOrigin } from '@/pages/agent-management-page';

describe('agent management helpers', () => {
  it('returns localhost origin when window is unavailable', () => {
    vi.stubGlobal('window', undefined);

    expect(defaultBrowserOrigin()).toBe('http://localhost:5173');
    vi.unstubAllGlobals();
  });

  it('builds MCP advertise URL with safe default port fallback', () => {
    expect(buildMcpAdvertiseUrl('10.0.0.7', '8081')).toBe('http://10.0.0.7:8081');
    expect(buildMcpAdvertiseUrl('10.0.0.7', '70000')).toBe('http://10.0.0.7:8081');
    expect(buildMcpAdvertiseUrl('', '8081')).toBe('');
  });
});

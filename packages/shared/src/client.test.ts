/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the client test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';

/**
 * Implements mock json response.
 */
function mockJsonResponse(payload: unknown, init?: { status?: number; ok?: boolean }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: vi.fn().mockResolvedValue(payload),
    text: vi
      .fn()
      .mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

describe('ApiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends auth header when getToken is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        id: 'd8ef4d73-c886-43cb-a6af-3eeb587f66af',
        displayName: 'Admin',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({
      baseUrl: 'http://localhost:3000',
      getToken: () => 'token-123',
    });

    await client.me();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer token-123');
  });

  it('throws formatted errors for non-ok responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse('denied', {
        status: 403,
        ok: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({ baseUrl: 'http://localhost:3000' });

    await expect(client.aiChat({ message: 'hello' })).rejects.toThrow('API 403: denied');
  });

  it('returns undefined for 204 responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn(),
      text: vi.fn(),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({ baseUrl: 'http://localhost:3000' });

    const result = await client.createCheck({
      name: 'Ping gateway',
      type: 'ICMP',
      target: '10.0.0.1',
      intervalSec: 60,
      timeoutMs: 1000,
      enabled: true,
    });

    expect(result).toBeUndefined();
  });

  it('validates input payloads before issuing requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({ baseUrl: 'http://localhost:3000' });

    await expect(client.login({ password: '' })).rejects.toThrow();
    await expect(client.setupAdmin({ confirm: true, password: 'short' })).rejects.toThrow();
    await expect(
      client.changePassword({
        confirm: true,
        currentPassword: '',
        newPassword: 'short',
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the probes test behavior.
 */
import net from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ping from 'ping';
import { runHttpCheck, runIcmpCheck, runTcpCheck } from '../src/probes';

vi.mock('ping', () => ({
  default: {
    promise: {
      probe: vi.fn(),
    },
  },
}));

const pingProbeMock = vi.mocked(ping.promise.probe);

describe('runHttpCheck', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns UP when status and keyword checks pass', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('hello world'),
      }),
    );

    const result = await runHttpCheck({
      target: 'https://example.com',
      timeoutMs: 500,
      expectedStatus: 200,
      keyword: 'hello',
    });

    expect(result.status).toBe('UP');
    expect(result.httpStatus).toBe(200);
    expect(result.errorMessage).toBeNull();
  });

  it('returns DOWN on expectation mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('body without token'),
      }),
    );

    const result = await runHttpCheck({
      target: 'https://example.com',
      timeoutMs: 500,
      expectedStatus: 201,
      keyword: 'missing',
    });

    expect(result.status).toBe('DOWN');
    expect(result.errorMessage).toBe('Expectation mismatch');
  });

  it('returns DOWN on request failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network fail')));

    const result = await runHttpCheck({
      target: 'https://example.com',
      timeoutMs: 500,
      expectedStatus: null,
      keyword: null,
    });

    expect(result.status).toBe('DOWN');
    expect(result.httpStatus).toBeNull();
    expect(result.errorMessage).toContain('network fail');
  });
});

describe('runTcpCheck', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fails fast on invalid host:port target', async () => {
    const result = await runTcpCheck({
      target: 'invalid-target',
      timeoutMs: 500,
    });

    expect(result.status).toBe('DOWN');
    expect(result.errorMessage).toBe('Invalid target');
  });

  it('returns UP when TCP socket connects successfully', async () => {
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function mockConnect(
      this: net.Socket,
    ) {
      queueMicrotask(() => {
        this.emit('connect');
      });
      return this;
    });

    const result = await runTcpCheck({
      target: '127.0.0.1:5432',
      timeoutMs: 500,
    });

    expect(result.status).toBe('UP');
    expect(result.errorMessage).toBeNull();
  });

  it('returns DOWN on connection error', async () => {
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function mockConnect(
      this: net.Socket,
    ) {
      queueMicrotask(() => {
        this.emit('error', new Error('connect ECONNREFUSED'));
      });
      return this;
    });

    const result = await runTcpCheck({
      target: '127.0.0.1:5432',
      timeoutMs: 500,
    });

    expect(result.status).toBe('DOWN');
    expect(result.errorMessage).toBeTruthy();
  });
});

describe('runIcmpCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns UP when probe is alive', async () => {
    pingProbeMock.mockResolvedValueOnce({ alive: true } as never);

    const result = await runIcmpCheck({
      target: '10.0.0.1',
      timeoutMs: 1000,
    });

    expect(result.status).toBe('UP');
    expect(result.errorMessage).toBeNull();
    expect(pingProbeMock).toHaveBeenCalledWith('10.0.0.1', { timeout: 1 });
  });

  it('returns DOWN when probe throws', async () => {
    pingProbeMock.mockRejectedValueOnce(new Error('icmp blocked'));

    const result = await runIcmpCheck({
      target: '10.0.0.1',
      timeoutMs: 1000,
    });

    expect(result.status).toBe('DOWN');
    expect(result.errorMessage).toContain('icmp blocked');
  });

  it('returns DOWN when probe reports host is unreachable', async () => {
    pingProbeMock.mockResolvedValueOnce({ alive: false } as never);

    const result = await runIcmpCheck({
      target: '10.0.0.2',
      timeoutMs: 1000,
    });

    expect(result.status).toBe('DOWN');
    expect(result.errorMessage).toBe('ICMP probe failed');
  });
});

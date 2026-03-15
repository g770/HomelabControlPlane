/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the terminal service test behavior.
 */
import { EventEmitter } from 'node:events';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node-pty';
import { TerminalService } from '../src/modules/terminal/terminal.service';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

type MockResponse = {
  response: Response;
  writes: string[];
  end: ReturnType<typeof vi.fn>;
};

type FakePty = {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
    dispose: () => void;
  };
  emitData: (data: string) => void;
  emitExit: (exitCode: number, signal?: number | undefined) => void;
};

type FakeSocket = EventEmitter & {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

/**
 * Creates fake pty.
 */
function createFakePty(): FakePty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (callback) => {
      dataListeners.add(callback);
      return {
        dispose: () => dataListeners.delete(callback),
      };
    },
    onExit: (callback) => {
      exitListeners.add(callback);
      return {
        dispose: () => exitListeners.delete(callback),
      };
    },
    emitData: (data) => {
      for (const callback of dataListeners) {
        callback(data);
      }
    },
    emitExit: (exitCode, signal) => {
      for (const callback of exitListeners) {
        callback({ exitCode, signal });
      }
    },
  };
}

/**
 * Creates fake socket.
 */
function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.send = vi.fn();
  socket.close = vi.fn((code?: number, reason?: string) => {
    socket.readyState = 3;
    socket.emit('close', code, reason);
  });
  return socket;
}

/**
 * Creates mock response.
 */
function createMockResponse(): MockResponse {
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const end = vi.fn(() => {
    for (const callback of listeners.close ?? []) {
      callback();
    }
  });
  const response = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end,
    on: vi.fn((event: string, callback: () => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]?.push(callback);
      return response;
    }),
  } as unknown as Response;

  return {
    response,
    writes,
    end,
  };
}

describe('TerminalService SSH session lifecycle', () => {
  const prisma = {
    host: {
      findUnique: vi.fn(),
    },
    agent: {
      findFirst: vi.fn(),
    },
  };
  const mcpService = {
    callTool: vi.fn(),
  };
  const auditService = {
    write: vi.fn(),
  };

  let service: TerminalService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    service = new TerminalService(prisma as any, mcpService as any, auditService as any);
    prisma.host.findUnique.mockResolvedValue({
      id: 'host-1',
      hostname: 'host-alpha',
      agent: null,
      facts: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('replays backlog and close events when ssh exits before stream subscription', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    const session = await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
      password: 'super-secret',
    });

    fakePty.emitData('connection refused\r\n');
    fakePty.emitExit(255);
    await Promise.resolve();

    const stream = createMockResponse();
    service.streamSshSession('user-1', session.sessionId, stream.response);

    const output = stream.writes.join('');
    expect(output).toContain('event: ready');
    expect(output).toContain('event: output');
    expect(output).toContain('connection refused');
    expect(output).toContain('event: close');
    expect(stream.end).toHaveBeenCalledTimes(1);
  });

  it('retains closed sessions briefly and expires them after retention window', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    const session = await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
    });

    fakePty.emitExit(255);
    await Promise.resolve();

    expect(() =>
      service.streamSshSession('user-1', session.sessionId, createMockResponse().response),
    ).not.toThrow();

    vi.advanceTimersByTime(120_001);
    expect(() =>
      service.streamSshSession('user-1', session.sessionId, createMockResponse().response),
    ).toThrow(NotFoundException);
  });

  it('finalizes sessions when first attachment never happens', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    const session = await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
    });

    vi.advanceTimersByTime(20_001);
    await Promise.resolve();

    const stream = createMockResponse();
    service.streamSshSession('user-1', session.sessionId, stream.response);

    const output = stream.writes.join('');
    expect(output).toContain('event: close');
    expect(output).toContain('attach_timeout');
    expect(output).toContain('terminal attach timeout');
    expect(fakePty.kill).toHaveBeenCalledTimes(1);
  });

  it('does not audit or retain SSH password values', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
      password: 'top-secret-password',
    });

    const call = auditService.write.mock.calls.find(
      (entry) => entry[0]?.action === 'terminal.ssh.session.create',
    );
    expect(call).toBeTruthy();
    expect(call?.[0]?.paramsJson).not.toHaveProperty('password');
  });

  it('auto-submits provided password when the prompt arrives through the pty stream', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
      password: 'split-prompt-secret',
    });

    fakePty.emitData("root@192.168.1.44's pass");
    fakePty.emitData('word: ');

    expect(fakePty.write).toHaveBeenCalledWith('split-prompt-secret\r');
  });

  it('attaches websocket clients, replays backlog, and forwards input and resize', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    const session = await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
    });

    fakePty.emitData('test shell ready\r\n');

    const socket = createFakeSocket();
    service.attachWebSocket({ sub: 'user-1' }, session.sessionId, socket as any);

    const payloads = socket.send.mock.calls.map((entry) => JSON.parse(String(entry[0])));
    expect(payloads.some((payload) => payload.type === 'attached')).toBe(true);
    expect(
      payloads.some(
        (payload) => payload.type === 'output' && payload.chunk.includes('test shell ready'),
      ),
    ).toBe(true);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls -la\r' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 140, rows: 40 })));

    expect(fakePty.write).toHaveBeenCalledWith('ls -la\r');
    expect(fakePty.resize).toHaveBeenCalledWith(140, 40);
  });

  it('rejects websocket attachments for non-owners', async () => {
    const fakePty = createFakePty();
    vi.mocked(spawn).mockReturnValue(fakePty as any);

    const session = await service.createSshSession('user-1', 'host-1', {
      confirm: true,
      target: '192.168.1.44',
      username: 'root',
      port: 22,
    });

    const socket = createFakeSocket();
    expect(() =>
      service.attachWebSocket({ sub: 'user-2' }, session.sessionId, socket as any),
    ).toThrow(NotFoundException);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });
});

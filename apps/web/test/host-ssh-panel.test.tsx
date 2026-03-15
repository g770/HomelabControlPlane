/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the host ssh panel test UI behavior.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostSshPanel } from '../src/components/host-ssh-panel';

const testState = vi.hoisted(() => {
  const apiFetch = vi.fn();
  const getToken = vi.fn(() => 'test-token');

  class FakeFitAddon {
    fit = vi.fn();
  }

  class FakeTerminal {
    static instances: FakeTerminal[] = [];

    cols = 120;
    rows = 32;
    options: { disableStdin?: boolean } = {};
    private dataHandler: ((data: string) => void) | null = null;
    private resizeHandler: ((event: { cols: number; rows: number }) => void) | null = null;

    /**
     * Creates the instance and stores the dependencies required by this type.
     */
    constructor(_options: Record<string, unknown>) {
      FakeTerminal.instances.push(this);
    }

    /**
     * Loads addon for the surrounding workflow.
     */
    loadAddon() {}
    open() {}
    write = vi.fn();
    reset = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();

    /**
     * Handles on data.
     */
    onData(callback: (data: string) => void) {
      this.dataHandler = callback;
      return {
        dispose: () => {
          this.dataHandler = null;
        },
      };
    }

    onResize(callback: (event: { cols: number; rows: number }) => void) {
      this.resizeHandler = callback;
      return {
        dispose: () => {
          this.resizeHandler = null;
        },
      };
    }

    /**
     * Handles emit data.
     */
    emitData(data: string) {
      this.dataHandler?.(data);
    }

    /**
     * Handles emit resize.
     */
    emitResize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizeHandler?.({ cols, rows });
    }
  }

  return {
    apiFetch,
    getToken,
    FakeFitAddon,
    FakeTerminal,
  };
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;

  readyState = FakeWebSocket.OPEN;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn((code = 1000, reason = 'closed') => {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  });

  /**
   * Creates the instance and stores the dependencies required by this type.
   */
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /**
   * Handles emit open.
   */
  emitOpen() {
    this.onopen?.();
  }

  /**
   * Handles emit message.
   */
  emitMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

vi.mock('@/lib/api', () => ({
  apiFetch: testState.apiFetch,
}));

vi.mock('@/lib/auth', () => ({
  getToken: testState.getToken,
}));

vi.mock('xterm', () => ({
  Terminal: testState.FakeTerminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: testState.FakeFitAddon,
}));

describe('HostSshPanel terminal websocket flow', () => {
  beforeEach(() => {
    testState.apiFetch.mockReset();
    testState.getToken.mockReturnValue('test-token');
    FakeWebSocket.instances = [];
    testState.FakeTerminal.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    testState.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/terminal/hosts/host-1/ssh/sessions' && init?.method === 'POST') {
        return {
          sessionId: 'session-1',
          hostId: 'host-1',
          hostName: 'host-alpha',
          target: '192.168.1.44',
          username: 'root',
          port: 22,
          openedAt: '2026-03-08T12:00:00.000Z',
        };
      }
      if (path === '/api/terminal/sessions/session-1' && init?.method === 'DELETE') {
        return undefined;
      }
      return undefined;
    });
  });

  it('opens a websocket terminal, shows attached state, and forwards emulator input', async () => {
    render(<HostSshPanel hostId="host-1" hostName="host-alpha" hostIp="192.168.1.44" />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(testState.apiFetch).toHaveBeenCalledWith(
        '/api/terminal/hosts/host-1/ssh/sessions',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeTruthy();
    socket?.emitOpen();
    socket?.emitMessage({
      type: 'attached',
      sessionId: 'session-1',
      target: '192.168.1.44',
      username: 'root',
      port: 22,
      openedAt: '2026-03-08T12:00:00.000Z',
    });

    await waitFor(() => {
      expect(screen.getByText(/Terminal attached to root@192\.168\.1\.44:22/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Attached' })).toBeDisabled();
    });

    const terminal = testState.FakeTerminal.instances[0];
    terminal?.emitData('ls -la\r');

    expect(socket?.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'ls -la\r' }));
  });
});

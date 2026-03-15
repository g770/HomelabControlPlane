/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the use host ssh session UI behavior.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalSshSocketServerMessage } from '@homelab/shared';
import { apiFetch } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { apiBaseUrl } from '@/lib/utils';

type SshSessionCreateResponse = {
  sessionId: string;
  hostId: string;
  hostName: string;
  target: string;
  username: string;
  port: number;
  openedAt: string;
};

type UseHostSshSessionOptions = {
  hostId: string;
  hostName: string;
  defaultTarget: string;
};

const maxTerminalChars = 240_000;
const websocketAttachTimeoutMs = 8_000;

/**
 * Provides the use host ssh session hook.
 */
export function useHostSshSession({ hostId, hostName, defaultTarget }: UseHostSshSessionOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [target, setTarget] = useState(defaultTarget);
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState('22');
  const [sshPassword, setSshPassword] = useState('');
  const [output, setOutput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const attachTimerRef = useRef<number | null>(null);
  const manualSocketCloseRef = useRef(false);
  const closeFrameReceivedRef = useRef(false);
  const attachedRef = useRef(false);

  const setTrackedSessionId = useCallback((value: string | null) => {
    sessionIdRef.current = value;
    setSessionId(value);
  }, []);

  const setAttachedState = useCallback((value: boolean) => {
    attachedRef.current = value;
    setAttached(value);
  }, []);

  useEffect(() => {
    if (sessionId || connecting) {
      return;
    }
    setTarget(defaultTarget);
  }, [connecting, defaultTarget, sessionId]);

  const appendOutput = useCallback((chunk: string) => {
    if (!chunk) {
      return;
    }
    setOutput((current) => {
      const next = `${current}${chunk}`;
      if (next.length <= maxTerminalChars) {
        return next;
      }
      return next.slice(next.length - maxTerminalChars);
    });
  }, []);

  const appendDebug = useCallback(
    (message: string) => {
      appendOutput(`\r\n[debug] ${message}\r\n`);
    },
    [appendOutput],
  );

  const clearAttachTimer = useCallback(() => {
    if (attachTimerRef.current !== null) {
      window.clearTimeout(attachTimerRef.current);
      attachTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(
    (code = 1000, reason = 'client closing') => {
      clearAttachTimer();
      const socket = socketRef.current;
      if (!socket) {
        return;
      }
      socketRef.current = null;
      try {
        socket.close(code, reason);
      } catch {
        // Best-effort close.
      }
    },
    [clearAttachTimer],
  );

  const deleteSession = useCallback(
    async (currentSessionId: string, debugLabel: string) => {
      try {
        await apiFetch(`/api/terminal/sessions/${currentSessionId}`, {
          method: 'DELETE',
        });
      } catch {
        appendDebug(`failed to close session id=${currentSessionId} via API (${debugLabel})`);
      }
    },
    [appendDebug],
  );

  const startSocket = useCallback(
    (nextSessionId: string) => {
      const token = getToken();
      if (!token) {
        setErrorText('Missing auth token.');
        appendDebug('cannot attach terminal: missing auth token');
        void deleteSession(nextSessionId, 'missing auth token');
        setTrackedSessionId(null);
        return;
      }

      manualSocketCloseRef.current = false;
      closeFrameReceivedRef.current = false;
      setAttachedState(false);
      clearAttachTimer();

      const socketUrl = buildTerminalSocketUrl(nextSessionId, token);
      appendDebug(`opening terminal socket sessionId=${nextSessionId}`);
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      attachTimerRef.current = window.setTimeout(() => {
        if (socketRef.current !== socket || attachedRef.current) {
          return;
        }
        setErrorText('Timed out waiting for terminal attachment.');
        appendDebug(
          `terminal attachment timeout after ${websocketAttachTimeoutMs}ms for session ${nextSessionId}`,
        );
        appendOutput('\r\n[terminal error] Timed out waiting for terminal attachment.\r\n');
        setStatusText('Session failed before terminal attachment.');
        setTrackedSessionId(null);
        setAttachedState(false);
        manualSocketCloseRef.current = true;
        closeSocket(4000, 'attach timeout');
        void deleteSession(nextSessionId, 'attach timeout');
      }, websocketAttachTimeoutMs);

      socket.onopen = () => {
        appendDebug(`terminal socket opened sessionId=${nextSessionId}`);
      };

      socket.onmessage = (event) => {
        let parsed: TerminalSshSocketServerMessage;
        try {
          parsed = JSON.parse(String(event.data)) as TerminalSshSocketServerMessage;
        } catch {
          appendDebug(`received non-json websocket payload sessionId=${nextSessionId}`);
          return;
        }

        if (parsed.type === 'attached') {
          clearAttachTimer();
          setAttachedState(true);
          appendDebug(`terminal attached sessionId=${nextSessionId}`);
          setStatusText(
            `Terminal attached to ${String(parsed.username ?? 'user')}@${String(parsed.target ?? 'target')}:${String(parsed.port ?? '22')}. Waiting for remote prompt...`,
          );
          appendOutput(
            `\r\n[terminal attached] ${String(parsed.username ?? 'user')}@${String(parsed.target ?? 'target')}:${String(parsed.port ?? '22')}\r\n`,
          );
          return;
        }

        if (parsed.type === 'output') {
          appendOutput(String(parsed.chunk ?? ''));
          return;
        }

        if (parsed.type === 'error') {
          const message = String(parsed.message ?? 'Terminal error.');
          appendDebug(`terminal error frame sessionId=${nextSessionId} message=${message}`);
          setErrorText(message);
          appendOutput(`\r\n[terminal error] ${message}\r\n`);
          return;
        }

        if (parsed.type === 'close') {
          const reason = String(parsed.reason ?? 'closed');
          closeFrameReceivedRef.current = true;
          appendDebug(`terminal close frame sessionId=${nextSessionId} reason=${reason}`);
          appendOutput(`\r\n[session closed] ${reason}\r\n`);
          setStatusText(`Session closed: ${reason}`);
          setAttachedState(false);
          setTrackedSessionId(null);
          manualSocketCloseRef.current = true;
          closeSocket(1000, 'server closed session');
        }
      };

      socket.onerror = () => {
        appendDebug(`terminal socket error event sessionId=${nextSessionId}`);
      };

      socket.onclose = (event) => {
        const wasAttached = attachedRef.current;
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        clearAttachTimer();
        setAttachedState(false);

        if (manualSocketCloseRef.current) {
          manualSocketCloseRef.current = false;
          return;
        }

        if (closeFrameReceivedRef.current) {
          return;
        }

        const reasonText = event.reason ? ` reason=${event.reason}` : '';
        appendDebug(
          `terminal socket closed sessionId=${nextSessionId} code=${event.code}${reasonText}`,
        );

        if (!wasAttached) {
          setErrorText('Terminal socket closed before attachment.');
          appendOutput('\r\n[terminal error] Terminal socket closed before attachment.\r\n');
          setStatusText('Session failed before terminal attachment.');
          setTrackedSessionId(null);
          return;
        }

        setErrorText('Terminal connection closed unexpectedly.');
        appendOutput(`\r\n[session disconnected] websocket code=${event.code}\r\n`);
        setStatusText('Terminal connection closed unexpectedly.');
        setTrackedSessionId(null);
      };
    },
    [
      appendDebug,
      appendOutput,
      clearAttachTimer,
      closeSocket,
      deleteSession,
      setAttachedState,
      setTrackedSessionId,
    ],
  );

  const connectSession = useCallback(async () => {
    if (connecting || sessionId) {
      return;
    }

    const normalizedTarget = target.trim();
    if (!normalizedTarget) {
      setErrorText('Target is required.');
      return;
    }

    const normalizedPort = Number(port);
    if (!Number.isFinite(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      setErrorText('Port must be between 1 and 65535.');
      return;
    }

    setConnecting(true);
    setErrorText(null);
    setStatusText(`Opening session to ${hostName} (${normalizedTarget}:${normalizedPort})...`);
    appendDebug(
      `opening session request hostId=${hostId} target=${normalizedTarget} username=${username.trim() || 'root'} port=${normalizedPort}`,
    );

    try {
      const response = await apiFetch<SshSessionCreateResponse>(
        `/api/terminal/hosts/${hostId}/ssh/sessions`,
        {
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
            target: normalizedTarget,
            username: username.trim(),
            port: normalizedPort,
            password: sshPassword.length > 0 ? sshPassword : undefined,
          }),
        },
      );

      setTrackedSessionId(response.sessionId);
      setStatusText(
        `Session opened for ${response.username}@${response.target}:${response.port}. Attaching terminal...`,
      );
      appendOutput(
        `\r\n[opening session] ${response.username}@${response.target}:${response.port}\r\n`,
      );
      appendDebug(`session created id=${response.sessionId}`);
      startSocket(response.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open SSH session.';
      appendDebug(`session create failed message=${message}`);
      setErrorText(message);
      setStatusText(null);
    } finally {
      setConnecting(false);
    }
  }, [
    appendDebug,
    appendOutput,
    connecting,
    hostId,
    hostName,
    port,
    sessionId,
    setTrackedSessionId,
    sshPassword,
    startSocket,
    target,
    username,
  ]);

  const sendInput = useCallback((data: string) => {
    if (!data) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !attachedRef.current) {
      return;
    }

    try {
      socket.send(JSON.stringify({ type: 'input', data }));
    } catch {
      setErrorText('Failed to send terminal input.');
    }
  }, []);

  const resizeTerminal = useCallback((cols: number, rows: number) => {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: Math.max(1, Math.round(cols)),
          rows: Math.max(1, Math.round(rows)),
        }),
      );
    } catch {
      setErrorText('Failed to resize terminal.');
    }
  }, []);

  const closeSession = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    manualSocketCloseRef.current = true;
    closeSocket();
    setAttachedState(false);

    if (!currentSessionId) {
      return;
    }

    setTrackedSessionId(null);
    appendDebug(`closing session id=${currentSessionId}`);
    setStatusText('Closing session...');
    await deleteSession(currentSessionId, 'user close');
  }, [appendDebug, closeSocket, deleteSession, setAttachedState, setTrackedSessionId]);

  useEffect(() => {
    return () => {
      manualSocketCloseRef.current = true;
      closeSocket();
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) {
        return;
      }
      void apiFetch(`/api/terminal/sessions/${currentSessionId}`, {
        method: 'DELETE',
      }).catch(() => {
        // Best-effort close during unmount.
      });
    };
  }, [closeSocket]);

  const resetUi = useCallback(() => {
    setOutput('');
    setSshPassword('');
    setStatusText(null);
    setErrorText(null);
    setTarget(defaultTarget);
  }, [defaultTarget]);

  const connected = useMemo(() => Boolean(sessionId), [sessionId]);

  return {
    attached,
    connected,
    connecting,
    sessionId,
    target,
    setTarget,
    username,
    setUsername,
    port,
    setPort,
    sshPassword,
    setSshPassword,
    output,
    statusText,
    errorText,
    connectSession,
    closeSession,
    sendInput,
    resizeTerminal,
    clearOutput: () => setOutput(''),
    resetUi,
  };
}

/**
 * Builds terminal socket url.
 */
function buildTerminalSocketUrl(sessionId: string, token: string) {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/terminal/sessions/${sessionId}/ws`;
  url.searchParams.set('token', token);
  return url.toString();
}

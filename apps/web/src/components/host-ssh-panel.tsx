/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the host ssh panel UI behavior.
 */
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SshTerminalEmulator } from './ssh-terminal-emulator';
import { useHostSshSession } from './use-host-ssh-session';

type HostSshPanelProps = {
  hostId: string;
  hostName: string;
  hostIp: string | null;
};

/**
 * Renders the host ssh panel view.
 */
export function HostSshPanel({ hostId, hostName, hostIp }: HostSshPanelProps) {
  const defaultTarget = useMemo(
    () => (hostIp && hostIp.trim().length > 0 ? hostIp : hostName),
    [hostIp, hostName],
  );
  const ssh = useHostSshSession({
    hostId,
    hostName,
    defaultTarget,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>SSH Session</CardTitle>
        <p className="text-xs text-muted-foreground">
          Starts an in-page SSH session to this host through the control-plane gateway.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_120px_minmax(0,1fr)_auto_auto]">
          <Input
            value={ssh.target}
            onChange={(event) => ssh.setTarget(event.target.value)}
            placeholder="Host IP or hostname"
          />
          <Input
            value={ssh.username}
            onChange={(event) => ssh.setUsername(event.target.value)}
            placeholder="SSH user"
          />
          <Input
            value={ssh.port}
            onChange={(event) => ssh.setPort(event.target.value)}
            placeholder="22"
            inputMode="numeric"
          />
          <Input
            type="password"
            value={ssh.sshPassword}
            onChange={(event) => ssh.setSshPassword(event.target.value)}
            placeholder="SSH password (optional)"
            autoComplete="new-password"
          />
          <Button
            type="button"
            onClick={() => void ssh.connectSession()}
            disabled={ssh.connected || ssh.connecting}
          >
            {ssh.connecting
              ? 'Connecting...'
              : ssh.attached
                ? 'Attached'
                : ssh.connected
                  ? 'Opening...'
                  : 'Connect'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void ssh.closeSession()}
            disabled={!ssh.connected}
          >
            Disconnect
          </Button>
        </div>

        {!hostIp && (
          <div className="text-xs text-amber-400">
            Host IP is not available from recent facts yet. Default target falls back to hostname;
            update target manually if needed.
          </div>
        )}
        {ssh.statusText && <div className="text-xs text-muted-foreground">{ssh.statusText}</div>}
        {ssh.errorText && <div className="text-xs text-rose-400">{ssh.errorText}</div>}

        <SshTerminalEmulator
          attached={ssh.attached}
          output={ssh.output}
          onInput={ssh.sendInput}
          onResize={ssh.resizeTerminal}
          emptyText={ssh.connected ? 'Waiting for terminal output...' : '[no terminal output yet]'}
        />

        <div className="text-[11px] text-muted-foreground">
          Password and key prompts appear inside the terminal. The optional password field is only
          used during session setup if the backend detects a prompt.
        </div>
      </CardContent>
    </Card>
  );
}

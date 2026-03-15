/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the host terminal dialog UI behavior.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SshTerminalEmulator } from './ssh-terminal-emulator';
import { useHostSshSession } from './use-host-ssh-session';

// Browser terminal dialog that proxies a full SSH session through the API terminal gateway.
type HostTerminalDialogProps = {
  hostId: string;
  hostName: string;
  hostTarget?: string;
  triggerLabel?: string;
  triggerVariant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'danger';
  triggerSize?: 'sm' | 'md' | 'lg';
  triggerClassName?: string;
};

/**
 * Renders the host terminal dialog view.
 */
export function HostTerminalDialog({
  hostId,
  hostName,
  hostTarget,
  triggerLabel = 'Terminal',
  triggerVariant = 'outline',
  triggerSize = 'sm',
  triggerClassName,
}: HostTerminalDialogProps) {
  const defaultTarget = useMemo(
    () => (hostTarget && hostTarget.trim().length > 0 ? hostTarget : hostName),
    [hostName, hostTarget],
  );
  const [open, setOpen] = useState(false);
  const ssh = useHostSshSession({
    hostId,
    hostName,
    defaultTarget,
  });
  const {
    attached,
    clearOutput,
    closeSession,
    connectSession,
    connected,
    connecting,
    errorText,
    output,
    port,
    resetUi,
    resizeTerminal,
    sendInput,
    setPort,
    setSshPassword,
    setTarget,
    setUsername,
    sshPassword,
    statusText,
    target,
    username,
  } = ssh;

  useEffect(() => {
    if (open) {
      return;
    }
    void closeSession();
    resetUi();
  }, [closeSession, open, resetUi]);

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        className={triggerClassName}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">SSH Terminal · {hostName}</div>
                <div className="text-xs text-muted-foreground">
                  Opens an interactive SSH shell through the control plane gateway.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={clearOutput}>
                  Clear
                </Button>
                <DialogClose asChild>
                  <Button type="button" variant="outline" size="sm">
                    Close
                  </Button>
                </DialogClose>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_120px_minmax(0,1fr)_auto_auto]">
              <Input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="Target host/IP"
              />
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="SSH user"
              />
              <Input
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="22"
                inputMode="numeric"
              />
              <Input
                type="password"
                value={sshPassword}
                onChange={(event) => setSshPassword(event.target.value)}
                placeholder="SSH password (optional)"
                autoComplete="new-password"
              />
              <Button
                type="button"
                onClick={() => void connectSession()}
                disabled={connected || connecting}
              >
                {connecting
                  ? 'Connecting...'
                  : attached
                    ? 'Attached'
                    : connected
                      ? 'Opening...'
                      : 'Connect'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void closeSession()}
                disabled={!connected}
              >
                Disconnect
              </Button>
            </div>

            {statusText && <div className="text-xs text-muted-foreground">{statusText}</div>}
            {errorText && <div className="text-xs text-rose-400">{errorText}</div>}

            <SshTerminalEmulator
              attached={attached}
              output={output}
              onInput={sendInput}
              onResize={resizeTerminal}
              emptyText={connected ? 'Waiting for terminal output...' : '[no terminal output yet]'}
            />

            <div className="text-[11px] text-muted-foreground">
              Password and key prompts appear inside the terminal. The optional password field is
              only used during session setup if the backend detects a prompt.
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

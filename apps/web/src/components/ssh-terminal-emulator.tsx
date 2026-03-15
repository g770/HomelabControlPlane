/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the ssh terminal emulator UI behavior.
 */
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';
import { cn } from '@/lib/utils';
import 'xterm/css/xterm.css';

type SshTerminalEmulatorProps = {
  attached: boolean;
  emptyText: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  output: string;
  className?: string;
};

/**
 * Renders the ssh terminal emulator view.
 */
export function SshTerminalEmulator({
  attached,
  emptyText,
  onInput,
  onResize,
  output,
  className,
}: SshTerminalEmulatorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const outputRef = useRef('');
  const inputHandlerRef = useRef(onInput);
  const resizeHandlerRef = useRef(onResize);

  useEffect(() => {
    inputHandlerRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    resizeHandlerRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      disableStdin: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
      fontSize: 12,
      rows: 24,
      scrollback: 5000,
      theme: {
        background: '#000000',
        foreground: '#6ee7b7',
        cursor: '#6ee7b7',
        selectionBackground: 'rgba(110, 231, 183, 0.24)',
      },
    });
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    resizeHandlerRef.current(terminal.cols, terminal.rows);

    const dataDisposable = terminal.onData((data: string) => {
      inputHandlerRef.current(data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      resizeHandlerRef.current(cols, rows);
    });

    let frameId: number | null = null;
    /**
     * Handles fit.
     */
    const handleFit = () => {
      if (!terminalRef.current || !fitAddonRef.current) {
        return;
      }
      fitAddonRef.current.fit();
      resizeHandlerRef.current(terminal.cols, terminal.rows);
    };

    /**
     * Implements schedule fit.
     */
    const scheduleFit = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        handleFit();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleFit();
          });
    resizeObserver?.observe(container);

    terminalRef.current = terminal;
    outputRef.current = '';

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      outputRef.current = '';
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.disableStdin = !attached;
  }, [attached]);

  useEffect(() => {
    if (!attached) {
      return;
    }
    terminalRef.current?.focus();
  }, [attached]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const previousOutput = outputRef.current;
    if (output === previousOutput) {
      return;
    }

    if (!output) {
      terminal.reset();
      outputRef.current = '';
      return;
    }

    if (output.startsWith(previousOutput)) {
      terminal.write(output.slice(previousOutput.length));
      outputRef.current = output;
      return;
    }

    terminal.reset();
    terminal.write(output);
    outputRef.current = output;
  }, [output]);

  return (
    <div
      className={cn(
        'relative h-[420px] overflow-hidden rounded-md border border-border/60 bg-black p-3',
        className,
      )}
    >
      <div
        ref={containerRef}
        className="h-full w-full [&_.xterm]:h-full [&_.xterm-viewport]:overflow-auto"
      />
      {output.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-xs text-emerald-300/60">
          {emptyText}
        </div>
      )}
    </div>
  );
}

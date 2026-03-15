/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the sse parser test behavior.
 */
import { describe, expect, it } from 'vitest';
import { parseSseEvents } from '@/lib/sse';

describe('parseSseEvents', () => {
  it('parses LF-delimited SSE events', () => {
    const parsed = parseSseEvents(
      'event: ready\ndata: {"ok":true}\n\nevent: output\ndata: {"chunk":"hi"}\n\n',
    );

    expect(parsed.events).toEqual([
      {
        eventType: 'ready',
        data: '{"ok":true}',
      },
      {
        eventType: 'output',
        data: '{"chunk":"hi"}',
      },
    ]);
    expect(parsed.remainder).toBe('');
  });

  it('parses CRLF-delimited events with multiline data', () => {
    const parsed = parseSseEvents(
      'event: output\r\ndata: {"chunk":"line1"}\r\ndata: {"chunk":"line2"}\r\n\r\n',
    );

    expect(parsed.events).toEqual([
      {
        eventType: 'output',
        data: '{"chunk":"line1"}\n{"chunk":"line2"}',
      },
    ]);
    expect(parsed.remainder).toBe('');
  });

  it('keeps incomplete trailing chunks in remainder', () => {
    const parsed = parseSseEvents(
      'event: ready\ndata: {"ok":true}\n\nevent: output\ndata: {"chunk":"partial"',
    );

    expect(parsed.events).toEqual([
      {
        eventType: 'ready',
        data: '{"ok":true}',
      },
    ]);
    expect(parsed.remainder).toBe('event: output\ndata: {"chunk":"partial"');
  });
});

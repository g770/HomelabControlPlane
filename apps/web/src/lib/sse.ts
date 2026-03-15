/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides sse helpers for the application.
 */
/**
 * Describes the parsed sse event shape.
 */
export type ParsedSseEvent = {
  eventType: string;
  data: string;
};

/**
 * Parses sse events.
 */
export function parseSseEvents(input: string): {
  events: ParsedSseEvent[];
  remainder: string;
} {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const frames = normalized.split('\n\n');
  const remainder = frames.pop() ?? '';
  const events: ParsedSseEvent[] = [];

  for (const frame of frames) {
    const lines = frame.split('\n');
    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim() || 'message';
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      continue;
    }

    events.push({
      eventType,
      data: dataLines.join('\n'),
    });
  }

  return {
    events,
    remainder,
  };
}

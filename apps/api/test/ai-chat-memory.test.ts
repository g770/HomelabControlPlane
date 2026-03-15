/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai chat memory test behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyChatMemorySummary,
  mergeChatMemorySummary,
  parseChatMemorySummary,
  readChatMemorySummaryFromJson,
  sanitizeChatMemoryText,
  toRecentTurns,
} from '../src/modules/ai/ai-chat-memory';

describe('ai chat memory helpers', () => {
  it('redacts credential-like values from text', () => {
    const raw =
      'Authorization: Bearer abc.def.ghi token:super-secret password=pass123 sk-abcdefghi eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb';
    const sanitized = sanitizeChatMemoryText(raw);

    expect(sanitized).toContain('Bearer [REDACTED]');
    expect(sanitized).toContain('token=[REDACTED]');
    expect(sanitized).toContain('password=[REDACTED]');
    expect(sanitized).toContain('[REDACTED_KEY]');
    expect(sanitized).toContain('[REDACTED_JWT]');
  });

  it('parses wrapped JSON summary payloads', () => {
    const raw = `model output:
    {
      "facts": ["password: pass123"],
      "decisions": ["Use host alpha for diagnostics"],
      "pendingActions": ["Collect logs"],
      "openQuestions": ["Is SSH enabled?"],
      "userPreferences": ["keep answers concise"],
      "importantIds": ["host-123"]
    }`;

    const parsed = parseChatMemorySummary(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.facts).toEqual(['password=[REDACTED]']);
    expect(parsed?.decisions).toEqual(['Use host alpha for diagnostics']);
  });

  it('returns null for invalid model output', () => {
    expect(parseChatMemorySummary('not json')).toBeNull();
  });

  it('merges summaries with case-insensitive dedupe', () => {
    const merged = mergeChatMemorySummary(
      {
        ...emptyChatMemorySummary(),
        facts: ['Host alpha is offline'],
        importantIds: ['host-123'],
      },
      {
        ...emptyChatMemorySummary(),
        facts: ['host alpha is offline', 'Disk usage exceeded 80%'],
        importantIds: ['HOST-123', 'alert-001'],
      },
    );

    expect(merged.facts).toEqual(['Host alpha is offline', 'Disk usage exceeded 80%']);
    expect(merged.importantIds).toEqual(['host-123', 'alert-001']);
  });

  it('maps recent messages to prompt turns in chronological order', () => {
    const now = new Date('2026-03-05T12:00:00.000Z');
    const descMessages = [
      {
        id: 'm3',
        role: 'USER',
        content: 'latest user',
        createdAt: new Date(now.getTime() + 2_000),
      },
      {
        id: 'm2',
        role: 'ASSISTANT',
        content: 'middle assistant',
        createdAt: new Date(now.getTime() + 1_000),
      },
      { id: 'm1', role: 'USER', content: 'oldest user', createdAt: now },
    ];

    const result = toRecentTurns(descMessages, 2);

    expect(result.oldestIncludedMessage).toMatchObject({ id: 'm2' });
    expect(result.recentTurns).toEqual([
      {
        role: 'assistant',
        content: 'middle assistant',
        createdAt: new Date(now.getTime() + 1_000).toISOString(),
      },
      {
        role: 'user',
        content: 'latest user',
        createdAt: new Date(now.getTime() + 2_000).toISOString(),
      },
    ]);
  });

  it('reads persisted summaries defensively', () => {
    expect(readChatMemorySummaryFromJson(null)).toEqual(emptyChatMemorySummary());
    expect(
      readChatMemorySummaryFromJson({
        facts: ['A'],
        decisions: ['B'],
      }),
    ).toMatchObject({
      facts: ['A'],
      decisions: ['B'],
    });
  });
});

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai personality test behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPersonalitySystemPrompt,
  DEFAULT_AI_PERSONALITY,
  readAiPersonalityFromJson,
  sanitizeAiPersonality,
} from '../src/modules/ai/ai-personality';

describe('ai personality helpers', () => {
  it('sanitizes line endings and trims whitespace', () => {
    const sanitized = sanitizeAiPersonality('  concise\r\noperator focused  ');
    expect(sanitized).toBe('concise\noperator focused');
  });

  it('reads personality from string and object json', () => {
    expect(readAiPersonalityFromJson('focused')).toBe('focused');
    expect(
      readAiPersonalityFromJson({
        personality: 'be practical',
      }),
    ).toBe('be practical');
    expect(
      readAiPersonalityFromJson({
        text: 'fallback field',
      }),
    ).toBe('fallback field');
  });

  it('returns null for invalid or empty values', () => {
    expect(readAiPersonalityFromJson({})).toBeNull();
    expect(readAiPersonalityFromJson(null)).toBeNull();
    expect(readAiPersonalityFromJson('   ')).toBeNull();
  });

  it('builds system prompts with optional personality context', () => {
    const base = 'You are an assistant.';

    expect(buildPersonalitySystemPrompt(base, '   ')).toBe(base);

    const withContext = buildPersonalitySystemPrompt(base, DEFAULT_AI_PERSONALITY);
    expect(withContext).toContain(base);
    expect(withContext).toContain('Operator-provided personality');
    expect(withContext).toContain(DEFAULT_AI_PERSONALITY.split(' ')[0] ?? 'You');
  });
});

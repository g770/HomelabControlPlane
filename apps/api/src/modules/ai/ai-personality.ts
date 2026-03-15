/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the ai personality logic for the repository.
 */
import type { Prisma } from '@prisma/client';

// Stores and renders the user-defined AI behavior profile that is merged into
// prompts across assistant features.
export const AI_PERSONALITY_MEMORY_KEY = 'ai_personality_v1';

/**
 * Defines the default_ai_personality constant.
 */
export const DEFAULT_AI_PERSONALITY = [
  'You are the homelab control-plane AI assistant.',
  'Be pragmatic, accurate, and action-oriented for operators.',
  'Prioritize safety and avoid claiming actions were executed unless tool output confirms it.',
  'Keep responses concise and clear.',
].join(' ');

const MAX_PERSONALITY_LENGTH = 6000;

// Normalizes user input so personality prompts are deterministic and bounded.
export function sanitizeAiPersonality(input: string) {
  return input.replace(/\r\n/g, '\n').trim().slice(0, MAX_PERSONALITY_LENGTH);
}

// Supports both legacy and current JSON storage shapes.
export function readAiPersonalityFromJson(
  value: Prisma.JsonValue | null | undefined,
): string | null {
  if (typeof value === 'string') {
    return nonEmptyOrNull(sanitizeAiPersonality(value));
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidate =
    typeof record.personality === 'string'
      ? record.personality
      : typeof record.text === 'string'
        ? record.text
        : null;
  if (!candidate) {
    return null;
  }

  return nonEmptyOrNull(sanitizeAiPersonality(candidate));
}

/**
 * Builds personality system prompt.
 */
export function buildPersonalitySystemPrompt(basePrompt: string, personality: string) {
  const trimmedBase = basePrompt.trim();
  const trimmedPersonality = personality.trim();
  if (!trimmedPersonality) {
    return trimmedBase;
  }

  return [
    trimmedBase,
    'Operator-provided personality and behavior preferences:',
    trimmedPersonality,
  ].join('\n\n');
}

/**
 * Implements non empty or null.
 */
function nonEmptyOrNull(value: string) {
  return value.length > 0 ? value : null;
}

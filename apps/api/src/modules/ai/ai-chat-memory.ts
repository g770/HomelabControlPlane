/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module implements the ai chat memory logic for the repository.
 */
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Defines the chat_memory_recent_messages constant.
 */
export const CHAT_MEMORY_RECENT_MESSAGES = 12;
/**
 * Defines the chat_memory_compaction_trigger_messages constant.
 */
export const CHAT_MEMORY_COMPACTION_TRIGGER_MESSAGES = 8;
/**
 * Defines the chat_memory_compaction_batch_messages constant.
 */
export const CHAT_MEMORY_COMPACTION_BATCH_MESSAGES = 24;

const MAX_MEMORY_LINE_LENGTH = 220;
const MAX_MEMORY_ITEMS_PER_BUCKET = 24;
const MAX_MEMORY_MESSAGE_LENGTH = 800;

const summaryBucketSchema = z
  .array(z.string().min(1).max(MAX_MEMORY_LINE_LENGTH))
  .max(MAX_MEMORY_ITEMS_PER_BUCKET);

/**
 * Implements chat memory summary schema.
 */
export const chatMemorySummarySchema = z
  .object({
    facts: summaryBucketSchema.default([]),
    decisions: summaryBucketSchema.default([]),
    pendingActions: summaryBucketSchema.default([]),
    openQuestions: summaryBucketSchema.default([]),
    userPreferences: summaryBucketSchema.default([]),
    importantIds: summaryBucketSchema.default([]),
  })
  .strict();

/**
 * Describes the chat memory summary shape.
 */
export type ChatMemorySummary = z.infer<typeof chatMemorySummarySchema>;

/**
 * Describes the chat recent turn shape.
 */
export type ChatRecentTurn = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

/**
 * Describes the chat prompt message shape.
 */
export type ChatPromptMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
};

/**
 * Implements empty chat memory summary.
 */
export function emptyChatMemorySummary(): ChatMemorySummary {
  return {
    facts: [],
    decisions: [],
    pendingActions: [],
    openQuestions: [],
    userPreferences: [],
    importantIds: [],
  };
}

/**
 * Implements read chat memory summary from json.
 */
export function readChatMemorySummaryFromJson(
  value: Prisma.JsonValue | null | undefined,
): ChatMemorySummary {
  const record = toRecord(value);
  if (!record) {
    return emptyChatMemorySummary();
  }

  return normalizeSummaryCandidate(record) ?? emptyChatMemorySummary();
}

/**
 * Parses chat memory summary.
 */
export function parseChatMemorySummary(raw: string): ChatMemorySummary | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsedDirect = parseJsonCandidate(trimmed);
  if (parsedDirect) {
    const normalized = normalizeSummaryCandidate(parsedDirect);
    if (normalized) {
      return normalized;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  const extracted = parseJsonCandidate(trimmed.slice(firstBrace, lastBrace + 1));
  if (!extracted) {
    return null;
  }
  return normalizeSummaryCandidate(extracted);
}

/**
 * Implements merge chat memory summary.
 */
export function mergeChatMemorySummary(
  base: ChatMemorySummary,
  incoming: ChatMemorySummary,
): ChatMemorySummary {
  return {
    facts: mergeMemoryBucket(base.facts, incoming.facts),
    decisions: mergeMemoryBucket(base.decisions, incoming.decisions),
    pendingActions: mergeMemoryBucket(base.pendingActions, incoming.pendingActions),
    openQuestions: mergeMemoryBucket(base.openQuestions, incoming.openQuestions),
    userPreferences: mergeMemoryBucket(base.userPreferences, incoming.userPreferences),
    importantIds: mergeMemoryBucket(base.importantIds, incoming.importantIds),
  };
}

/**
 * Implements sanitize chat memory text.
 */
export function sanitizeChatMemoryText(raw: string, maxLength = MAX_MEMORY_MESSAGE_LENGTH) {
  const normalized = raw
    .replace(/\r\n/g, '\n')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bauthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+/gi, 'authorization: Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      (_match, key: string) => `${key}=[REDACTED]`,
    );

  const collapsedWhitespace = normalized.replace(/\s+/g, ' ').trim();
  if (collapsedWhitespace.length <= maxLength) {
    return collapsedWhitespace;
  }
  return `${collapsedWhitespace.slice(0, maxLength - 3)}...`;
}

/**
 * Implements to recent turns.
 */
export function toRecentTurns(
  inputMessagesDesc: ChatPromptMessage[],
  maxMessages = CHAT_MEMORY_RECENT_MESSAGES,
): {
  recentTurns: ChatRecentTurn[];
  oldestIncludedMessage: { id: string; createdAt: Date } | null;
} {
  const selected = inputMessagesDesc.slice(0, maxMessages);
  const oldestIncluded = selected.length > 0 ? selected[selected.length - 1] : null;
  const recentTurns = selected
    .slice()
    .reverse()
    .map((message) => ({
      role: message.role === 'ASSISTANT' ? ('assistant' as const) : ('user' as const),
      content: sanitizeChatMemoryText(message.content),
      createdAt: message.createdAt.toISOString(),
    }));

  return {
    recentTurns,
    oldestIncludedMessage: oldestIncluded
      ? { id: oldestIncluded.id, createdAt: oldestIncluded.createdAt }
      : null,
  };
}

/**
 * Implements merge memory bucket.
 */
function mergeMemoryBucket(existing: string[], incoming: string[]) {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of [...existing, ...incoming]) {
    const sanitized = sanitizeMemoryLine(entry);
    if (!sanitized) {
      continue;
    }
    const key = sanitized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(sanitized);
    if (result.length >= MAX_MEMORY_ITEMS_PER_BUCKET) {
      break;
    }
  }

  return result;
}

/**
 * Implements normalize summary candidate.
 */
function normalizeSummaryCandidate(value: unknown): ChatMemorySummary | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const candidate = {
    facts: sanitizeMemoryList(record.facts),
    decisions: sanitizeMemoryList(record.decisions),
    pendingActions: sanitizeMemoryList(record.pendingActions),
    openQuestions: sanitizeMemoryList(record.openQuestions),
    userPreferences: sanitizeMemoryList(record.userPreferences),
    importantIds: sanitizeMemoryList(record.importantIds),
  };

  const parsed = chatMemorySummarySchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

/**
 * Implements sanitize memory list.
 */
function sanitizeMemoryList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const sanitized = sanitizeMemoryLine(entry);
    if (!sanitized) {
      continue;
    }
    output.push(sanitized);
    if (output.length >= MAX_MEMORY_ITEMS_PER_BUCKET) {
      break;
    }
  }
  return output;
}

/**
 * Implements sanitize memory line.
 */
function sanitizeMemoryLine(value: string) {
  const sanitized = sanitizeChatMemoryText(value, MAX_MEMORY_LINE_LENGTH);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Parses json candidate.
 */
function parseJsonCandidate(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

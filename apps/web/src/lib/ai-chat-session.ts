/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This utility module provides ai chat session helpers for the application.
 */
import { apiBaseUrl } from '@/lib/utils';
import { getToken } from '@/lib/auth';

/**
 * Describes the ai chat message shape.
 */
export type AiChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/**
 * Describes the ai tool trace shape.
 */
export type AiToolTrace = {
  kind?: string;
  tool?: string;
  agentId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  proposalId?: string;
  error?: string;
};

type AiChatPersistedState = {
  messages: AiChatMessage[];
  conversationId?: string;
  toolTraces: AiToolTrace[];
  contextHostId: string;
  chatError: string | null;
};

/**
 * Describes the ai chat state shape.
 */
export type AiChatState = AiChatPersistedState & {
  isPending: boolean;
};

const storageKey = 'homelab.ai.chat.session.v1';
const maxMessages = 200;
const maxTraces = 200;
const subscribers = new Set<() => void>();
let state: AiChatState = {
  ...loadPersistedState(),
  isPending: false,
};

/**
 * Implements notify.
 */
function notify() {
  persistState(state);
  for (const subscriber of subscribers) {
    subscriber();
  }
}

/**
 * Gets ai chat state.
 */
export function getAiChatState() {
  return state;
}

/**
 * Implements subscribe ai chat state.
 */
export function subscribeAiChatState(subscriber: () => void) {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/**
 * Sets ai chat context.
 */
export function setAiChatContext(input: { contextHostId?: string }) {
  state = {
    ...state,
    contextHostId: input.contextHostId ?? state.contextHostId,
  };
  notify();
}

/**
 * Implements clear ai chat session.
 */
export function clearAiChatSession() {
  if (state.isPending) {
    return;
  }

  state = {
    ...state,
    messages: [],
    conversationId: undefined,
    toolTraces: [],
    chatError: null,
  };
  notify();
}

/**
 * Implements send ai chat message.
 */
export async function sendAiChatMessage(input: { message: string }) {
  const trimmed = input.message.trim();
  if (!trimmed) {
    return;
  }
  if (state.isPending) {
    throw new Error('An AI request is already in progress.');
  }

  state = {
    ...state,
    isPending: true,
    chatError: null,
    messages: trimMessages([...state.messages, { role: 'user', content: trimmed }]),
  };
  notify();

  const token = getToken();
  if (!token) {
    handleChatFailure('Missing auth token');
    return;
  }

  try {
    const response = await fetch(`${apiBaseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: state.conversationId,
        message: trimmed,
        contextHostId: state.contextHostId || undefined,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(await response.text());
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedAssistantToken = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        let eventType = 'message';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          }
          if (line.startsWith('data:')) {
            data = line.slice(5).trim();
          }
        }

        if (!data) {
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (eventType === 'trace') {
          state = {
            ...state,
            toolTraces: trimTraces([...state.toolTraces, parsed as AiToolTrace]),
          };
          notify();
          continue;
        }

        if (eventType === 'token') {
          receivedAssistantToken = true;
          const content = String(parsed.content ?? '');
          if (content.length === 0) {
            continue;
          }
          appendAssistantToken(content);
          continue;
        }

        if (eventType === 'done') {
          const nextConversationId = parsed.conversationId;
          state = {
            ...state,
            conversationId:
              typeof nextConversationId === 'string' ? nextConversationId : state.conversationId,
          };
          if (!receivedAssistantToken) {
            state = {
              ...state,
              messages: trimMessages([
                ...state.messages,
                {
                  role: 'assistant',
                  content:
                    'No assistant output was returned. Check API logs for /api/ai/chat and confirm the OpenAI API key is configured in Settings if model responses are expected.',
                },
              ]),
            };
          }
          notify();
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chat request failed.';
    handleChatFailure(message);
    return;
  }

  state = {
    ...state,
    isPending: false,
  };
  notify();
}

/**
 * Implements append assistant token.
 */
function appendAssistantToken(content: string) {
  const messages = [...state.messages];
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant') {
    messages[messages.length - 1] = {
      ...lastMessage,
      content: `${lastMessage.content}${content}`,
    };
  } else {
    messages.push({ role: 'assistant', content });
  }

  state = {
    ...state,
    messages: trimMessages(messages),
  };
  notify();
}

/**
 * Handles chat failure.
 */
function handleChatFailure(message: string) {
  state = {
    ...state,
    isPending: false,
    chatError: message,
    messages: trimMessages([
      ...state.messages,
      { role: 'assistant', content: `AI request failed: ${message}` },
    ]),
  };
  notify();
}

/**
 * Implements trim messages.
 */
function trimMessages(messages: AiChatMessage[]) {
  if (messages.length <= maxMessages) {
    return messages;
  }
  return messages.slice(messages.length - maxMessages);
}

/**
 * Implements trim traces.
 */
function trimTraces(traces: AiToolTrace[]) {
  if (traces.length <= maxTraces) {
    return traces;
  }
  return traces.slice(traces.length - maxTraces);
}

/**
 * Loads persisted state.
 */
function loadPersistedState(): AiChatPersistedState {
  if (typeof window === 'undefined') {
    return {
      messages: [],
      conversationId: undefined,
      toolTraces: [],
      contextHostId: '',
      chatError: null,
    };
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {
        messages: [],
        conversationId: undefined,
        toolTraces: [],
        contextHostId: '',
        chatError: null,
      };
    }

    const parsed = JSON.parse(raw) as Partial<AiChatPersistedState>;
    return {
      messages: Array.isArray(parsed.messages)
        ? trimMessages(
            parsed.messages
              .map(
                (message): AiChatMessage => ({
                  role: message.role === 'assistant' ? 'assistant' : 'user',
                  content: String(message.content ?? ''),
                }),
              )
              .filter((message) => message.content.trim().length > 0),
          )
        : [],
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined,
      toolTraces: Array.isArray(parsed.toolTraces)
        ? trimTraces(
            parsed.toolTraces.map((trace) => ({
              kind: typeof trace.kind === 'string' ? trace.kind : undefined,
              tool: typeof trace.tool === 'string' ? trace.tool : undefined,
              agentId: typeof trace.agentId === 'string' ? trace.agentId : undefined,
              params: toRecord(trace.params),
              result: toRecord(trace.result),
              proposalId: typeof trace.proposalId === 'string' ? trace.proposalId : undefined,
              error: typeof trace.error === 'string' ? trace.error : undefined,
            })),
          )
        : [],
      contextHostId: typeof parsed.contextHostId === 'string' ? parsed.contextHostId : '',
      chatError: typeof parsed.chatError === 'string' ? parsed.chatError : null,
    };
  } catch {
    return {
      messages: [],
      conversationId: undefined,
      toolTraces: [],
      contextHostId: '',
      chatError: null,
    };
  }
}

/**
 * Implements persist state.
 */
function persistState(next: AiChatState) {
  if (typeof window === 'undefined') {
    return;
  }

  const payload: AiChatPersistedState = {
    messages: next.messages,
    conversationId: next.conversationId,
    toolTraces: next.toolTraces,
    contextHostId: next.contextHostId,
    chatError: next.chatError,
  };

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Ignore persistence failures and keep in-memory state as source of truth.
  }
}

/**
 * Implements to record.
 */
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

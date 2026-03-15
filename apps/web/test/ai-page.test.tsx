/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the ai page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiPage } from '@/pages/ai-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const aiChatState = {
  messages: [],
  conversationId: undefined,
  toolTraces: [],
  contextHostId: '',
  chatError: null,
  isPending: false,
};

vi.mock('@/lib/ai-chat-session', () => ({
  clearAiChatSession: vi.fn(),
  getAiChatState: () => aiChatState,
  sendAiChatMessage: vi.fn(),
  setAiChatContext: vi.fn(),
  subscribeAiChatState: () => () => {},
}));

/**
 * Renders the render page view.
 */
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AiPage />
    </QueryClientProvider>,
  );
}

describe('AiPage', () => {
  beforeEach(() => {
    aiChatState.messages = [];
    aiChatState.conversationId = undefined;
    aiChatState.toolTraces = [];
    aiChatState.contextHostId = '';
    aiChatState.chatError = null;
    aiChatState.isPending = false;
  });

  it('points disabled AI setup to Settings', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/hosts') {
        return [];
      }
      if (path === '/api/ai/status') {
        return { enabled: false };
      }

      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderPage();

    expect(await screen.findByText(/AI disabled:/)).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText(/Start by asking about host health or alerts\./)).toBeInTheDocument();
    expect(screen.queryByText('Tool Trace')).not.toBeInTheDocument();
    expect(screen.queryByText('No tool traces yet.')).not.toBeInTheDocument();
  });

  it('ignores stored tool traces and keeps the chat-focused layout', async () => {
    aiChatState.messages = [
      {
        role: 'assistant',
        content: 'Current alerts are concentrated on the storage host.',
      },
    ];
    aiChatState.toolTraces = [
      {
        kind: 'tool_result',
        tool: 'logs.tail',
        result: { lines: ['redacted'] },
      },
    ];

    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/hosts') {
        return [];
      }
      if (path === '/api/ai/status') {
        return { enabled: true };
      }

      throw new Error(`Unexpected apiFetch call: ${path}`);
    });

    renderPage();

    expect(await screen.findByText('AI Assistant')).toBeInTheDocument();
    expect(
      screen.getByText('Current alerts are concentrated on the storage host.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Tool Trace')).not.toBeInTheDocument();
    expect(screen.queryByText('No tool traces yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('logs.tail')).not.toBeInTheDocument();
  });
});

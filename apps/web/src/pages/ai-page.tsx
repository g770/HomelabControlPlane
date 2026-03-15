/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the ai page route view.
 */
import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';
import {
  clearAiChatSession,
  getAiChatState,
  sendAiChatMessage,
  setAiChatContext,
  subscribeAiChatState,
} from '@/lib/ai-chat-session';
import type { HostSummary } from '@/types/api';

const suggestedQuestions = [
  'What is broken right now?',
  'Why is host latency high?',
  'Show failing checks on my selected host.',
  'Propose a safe restart plan for this service.',
];

/**
 * Renders the ai page view.
 */
export function AiPage() {
  const [input, setInput] = useState('');
  const chatState = useSyncExternalStore(subscribeAiChatState, getAiChatState, getAiChatState);
  const contextHostId = chatState.contextHostId;

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => apiFetch<HostSummary[]>('/api/hosts'),
  });
  const aiStatusQuery = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => apiFetch<{ enabled: boolean }>('/api/ai/status'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Assistant</CardTitle>
        <CardDescription>
          Answers from inventory/check/alert context and MCP tools. Write actions require explicit
          approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {aiStatusQuery.data && !aiStatusQuery.data.enabled && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            AI disabled: configure the OpenAI API key in <code>Settings</code> to enable
            model-backed responses.
          </div>
        )}
        <div className="grid gap-3">
          <Select
            value={contextHostId}
            onChange={(event) => setAiChatContext({ contextHostId: event.target.value })}
          >
            <option value="">Context host (optional)</option>
            {(hostsQuery.data ?? []).map((host) => (
              <option key={host.id} value={host.id}>
                {host.hostname}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-wrap gap-2">
          {suggestedQuestions.map((question) => (
            <Button key={question} size="sm" variant="secondary" onClick={() => setInput(question)}>
              {question}
            </Button>
          ))}
        </div>

        <div className="max-h-[420px] space-y-2 overflow-auto rounded-md border border-border/60 p-3">
          {chatState.messages.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Start by asking about host health or alerts.
            </p>
          )}
          {chatState.messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`rounded-md border p-2 text-sm ${
                message.role === 'user'
                  ? 'ml-8 border-primary/50 bg-primary/10'
                  : 'mr-8 border-border/60 bg-background/70'
              }`}
            >
              <div className="mb-1 text-xs uppercase text-muted-foreground">{message.role}</div>
              <div>{message.content}</div>
            </div>
          ))}
          {chatState.isPending && (
            <div className="mr-8 flex items-center gap-2 rounded-md border border-border/60 bg-background/70 p-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Waiting for AI response...
            </div>
          )}
        </div>

        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = input.trim();
            if (!trimmed) {
              return;
            }
            setInput('');
            void sendAiChatMessage({
              message: trimmed,
            });
          }}
        >
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about your homelab..."
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={chatState.isPending}>
              {chatState.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Thinking...
                </span>
              ) : (
                'Send'
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={chatState.isPending}
              onClick={() => {
                clearAiChatSession();
                setInput('');
              }}
            >
              Clear Chat
            </Button>
          </div>
          {chatState.chatError && (
            <div className="text-sm text-rose-400">AI request failed: {chatState.chatError}</div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

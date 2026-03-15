/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the dashboard agent page test UI behavior.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardAgentPage } from '@/pages/dashboard-agent-page';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const runId = '4f2026f5-58f6-4ef7-a53e-278fddf17de9';

/**
 * Implements mock dashboard agent requests.
 */
function mockDashboardAgentRequests() {
  const deletedRunIds = new Set<string>();

  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/dashboard-agent/status') {
      const latestDeleted = deletedRunIds.has(runId);
      return {
        enabled: true,
        intervalSec: 300,
        isRunning: false,
        nextScheduledRunAt: '2026-03-07T12:05:00.000Z',
        lastRunAt: latestDeleted ? null : '2026-03-07T12:00:00.000Z',
        lastRunId: latestDeleted ? null : runId,
        lastRunStatus: latestDeleted ? null : 'COMPLETED',
      };
    }

    if (path === '/api/dashboard-agent/runs?limit=20') {
      return {
        runs: deletedRunIds.has(runId)
          ? []
          : [
              {
                id: runId,
                trigger: 'MANUAL',
                triggeredByUserId: null,
                startedAt: '2026-03-07T12:00:00.000Z',
                finishedAt: '2026-03-07T12:00:02.000Z',
                status: 'COMPLETED',
                findingCount: 1,
                highPriorityCount: 1,
                highlights: [
                  {
                    id: 'finding-1',
                    title: 'Host pressure',
                    summary: 'Resource pressure was detected.',
                    severity: 'warn',
                    category: 'host',
                    confidence: 0.8,
                    evidence: ['CPU 94%'],
                    investigation: ['Review top processes for the affected host.'],
                    recommendedActions: ['Inspect top processes'],
                  },
                ],
                error: null,
                summary: {
                  analyzedAt: '2026-03-07T12:00:02.000Z',
                  context: {
                    hosts: 1,
                    monitors: 1,
                    services: 1,
                    activeAlerts: 0,
                    discoveryRunsReviewed: 0,
                    aiQuestionsReviewed: 0,
                    eventsReviewed: 2,
                  },
                  notes: [],
                  toolCalls: [],
                  openAiCalls: [
                    {
                      id: 'ai-call-1',
                      step: 'refine_highlights',
                      model: 'gpt-5-mini',
                      status: 'completed',
                      startedAt: '2026-03-07T12:00:01.000Z',
                      finishedAt: '2026-03-07T12:00:02.000Z',
                      durationMs: 1000,
                      requestPayload: { context: { hosts: 1 } },
                      responsePayload: { id: 'resp_123' },
                      outputText: '{"highlights":[]}',
                      reasoningSummary: ['Compared findings against recent events.'],
                      usage: {
                        inputTokens: 120,
                        outputTokens: 30,
                        reasoningTokens: 10,
                        totalTokens: 150,
                      },
                      error: null,
                    },
                  ],
                },
              },
            ],
      };
    }

    if (path === '/api/dashboard-agent/highlights') {
      return deletedRunIds.has(runId)
        ? {
            runId: null,
            status: null,
            generatedAt: null,
            highlights: [],
          }
        : {
            runId,
            status: 'COMPLETED',
            generatedAt: '2026-03-07T12:00:02.000Z',
            highlights: [
              {
                id: 'finding-1',
                title: 'Host pressure',
                summary: 'Resource pressure was detected.',
                severity: 'warn',
                category: 'host',
                confidence: 0.8,
                evidence: ['CPU 94%'],
                investigation: ['Review top processes for the affected host.'],
                recommendedActions: ['Inspect top processes'],
              },
            ],
          };
    }

    if (path === `/api/dashboard-agent/runs/${runId}` && init?.method === 'DELETE') {
      deletedRunIds.add(runId);
      return {
        ok: true,
        deleted: true,
        runId,
      };
    }

    if (path === `/api/dashboard-agent/runs/${runId}`) {
      if (deletedRunIds.has(runId)) {
        throw new Error('Dashboard agent run not found');
      }

      return {
        run: {
          id: runId,
          trigger: 'MANUAL',
          triggeredByUserId: null,
          startedAt: '2026-03-07T12:00:00.000Z',
          finishedAt: '2026-03-07T12:00:02.000Z',
          status: 'COMPLETED',
          findingCount: 1,
          highPriorityCount: 1,
          highlights: [
            {
              id: 'finding-1',
              title: 'Host pressure',
              summary: 'Resource pressure was detected.',
              severity: 'warn',
              category: 'host',
              confidence: 0.8,
              evidence: ['CPU 94%'],
              investigation: ['Review top processes for the affected host.'],
              recommendedActions: ['Inspect top processes'],
            },
          ],
          error: null,
          summary: {
            analyzedAt: '2026-03-07T12:00:02.000Z',
            context: {
              hosts: 1,
              monitors: 1,
              services: 1,
              activeAlerts: 0,
              discoveryRunsReviewed: 0,
              aiQuestionsReviewed: 0,
              eventsReviewed: 2,
            },
            notes: [],
            toolCalls: [],
            openAiCalls: [
              {
                id: 'ai-call-1',
                step: 'refine_highlights',
                model: 'gpt-5-mini',
                status: 'completed',
                startedAt: '2026-03-07T12:00:01.000Z',
                finishedAt: '2026-03-07T12:00:02.000Z',
                durationMs: 1000,
                requestPayload: { context: { hosts: 1 } },
                responsePayload: { id: 'resp_123' },
                outputText: '{"highlights":[]}',
                reasoningSummary: ['Compared findings against recent events.'],
                usage: {
                  inputTokens: 120,
                  outputTokens: 30,
                  reasoningTokens: 10,
                  totalTokens: 150,
                },
                error: null,
              },
            ],
          },
        },
      };
    }

    throw new Error(`Unexpected apiFetch call: ${path}`);
  });
}

/**
 * Renders the render page view.
 */
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardAgentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DashboardAgentPage', () => {
  it('hides highlight evidence lines on the page', async () => {
    mockDashboardAgentRequests();

    renderPage();

    expect(await screen.findByText('Latest Highlights')).toBeInTheDocument();
    expect(screen.queryByText('CPU 94%')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Review top processes for the affected host\./)).not.toHaveLength(0);
  });

  it('keeps the debug console collapsed by default and expands on demand for the built-in admin account', async () => {
    mockDashboardAgentRequests();

    renderPage();

    expect(await screen.findByText('OpenAI Debug Console')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Debug Console' })).toBeInTheDocument();
    expect(screen.queryByText('Request Payload')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Debug Console' }));
    fireEvent.click(screen.getByText('refine_highlights'));

    expect(await screen.findByText('Reasoning summary')).toBeInTheDocument();
    expect(await screen.findByText('Request Payload')).toBeInTheDocument();
    expect(await screen.findByText('Response Payload')).toBeInTheDocument();
  });

  it('shows debug payload details and delete controls for the built-in admin account', async () => {
    mockDashboardAgentRequests();

    renderPage();

    expect(await screen.findByText('OpenAI Debug Console')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Delete$/i })).toBeInTheDocument();
    expect(screen.queryByText('Request Payload')).not.toBeInTheDocument();
  });

  it('deletes previous runs for the built-in admin account', async () => {
    mockDashboardAgentRequests();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/i }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(`/api/dashboard-agent/runs/${runId}`, {
        method: 'DELETE',
        body: JSON.stringify({
          confirm: true,
        }),
      });
    });
  });
});

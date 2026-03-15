/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This test file verifies the dashboard agent service test behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardAgentService } from '../src/modules/dashboard-agent/dashboard-agent.service';

/**
 * Creates service.
 */
function createService(openAiEnabled = false) {
  const prisma = {
    dashboardAgentConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    dashboardAgentRun: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    agent: {
      findFirst: vi.fn(),
    },
  };

  const configService = {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === 'DASHBOARD_AGENT_ENABLED') {
        return true;
      }
      if (key === 'DASHBOARD_AGENT_INTERVAL_SEC') {
        return 300;
      }
      return fallback;
    }),
  };

  const auditService = {
    write: vi.fn(),
  };
  const eventsService = {
    emit: vi.fn(),
  };
  const mcpService = {
    callTool: vi.fn(),
  };
  const dashboardAgentMcpService = {
    callTool: vi.fn(),
  };
  const aiProviderService = {
    getClient: vi.fn().mockResolvedValue(
      openAiEnabled
        ? {
            responses: {
              create: vi.fn(),
            },
          }
        : null,
    ),
    getModel: vi.fn(() => 'gpt-5-mini'),
    isConfigured: vi.fn().mockResolvedValue(openAiEnabled),
  };

  const service = new DashboardAgentService(
    prisma as never,
    configService as never,
    auditService as never,
    eventsService as never,
    mcpService as never,
    dashboardAgentMcpService as never,
    aiProviderService as never,
  );

  return {
    service,
    prisma,
    auditService,
    aiProviderService,
  };
}

/**
 * Implements make run summary with debug.
 */
function makeRunSummaryWithDebug() {
  return {
    analyzedAt: '2026-03-07T12:00:00.000Z',
    context: {
      hosts: 2,
      monitors: 3,
      services: 4,
      activeAlerts: 1,
      discoveryRunsReviewed: 1,
      aiQuestionsReviewed: 2,
      eventsReviewed: 5,
    },
    notes: ['AI refinement was attempted for final highlight prioritization.'],
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
        requestPayload: { input: 'sanitized' },
        responsePayload: { id: 'resp_1' },
        outputText: '{"highlights":[]}',
        reasoningSummary: ['Compared anomaly patterns against monitor and event history.'],
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          reasoningTokens: 12,
          totalTokens: 150,
        },
        error: null,
      },
    ],
  };
}

/**
 * Implements make highlight.
 */
function makeHighlight(summary = 'Resource pressure observed') {
  return {
    id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
    title: 'Host pressure',
    summary,
    severity: 'warn' as const,
    category: 'host' as const,
    confidence: 0.8,
    evidence: ['CPU 94%'],
    investigation: [],
    recommendedActions: ['Inspect top processes'],
  };
}

/**
 * Implements make context.
 */
function makeContext() {
  return {
    homelabSnapshot: {
      hosts: 1,
      services: 1,
      monitors: 1,
      activeAlerts: 0,
    },
    hostMetrics: [],
    monitorResults: [],
    discoveryRuns: [],
    aiQuestions: [],
    events: [],
  };
}

describe('DashboardAgentService openai debug traces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redacts debug traces when includeDebug is false and preserves them when it is true', async () => {
    const { service, prisma } = createService();
    prisma.dashboardAgentRun.findMany.mockResolvedValueOnce([
      {
        id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
        trigger: 'MANUAL',
        triggeredByUserId: null,
        startedAt: new Date('2026-03-07T12:00:00.000Z'),
        finishedAt: new Date('2026-03-07T12:00:03.000Z'),
        status: 'COMPLETED',
        findingCount: 1,
        highPriorityCount: 1,
        highlights: [],
        summary: makeRunSummaryWithDebug(),
        error: null,
      },
    ]);

    const redactedResult = await service.listRuns(10, { includeDebug: false });
    const redactedSummary = redactedResult.runs[0]?.summary as Record<string, unknown> | null;
    expect(redactedSummary).toBeTruthy();
    expect(redactedSummary).not.toHaveProperty('openAiCalls');

    prisma.dashboardAgentRun.findMany.mockResolvedValueOnce([
      {
        id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
        trigger: 'MANUAL',
        triggeredByUserId: null,
        startedAt: new Date('2026-03-07T12:00:00.000Z'),
        finishedAt: new Date('2026-03-07T12:00:03.000Z'),
        status: 'COMPLETED',
        findingCount: 1,
        highPriorityCount: 1,
        highlights: [],
        summary: makeRunSummaryWithDebug(),
        error: null,
      },
    ]);

    const fullResult = await service.listRuns(10, { includeDebug: true });
    const fullSummary = fullResult.runs[0]?.summary as Record<string, unknown> | null;
    expect(fullSummary).toBeTruthy();
    expect(fullSummary).toHaveProperty('openAiCalls');
  });

  it('captures completed openai debug call with reasoning summary and usage', async () => {
    const { service, aiProviderService } = createService(true);
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockResolvedValue({
          id: 'resp_123',
          model: 'gpt-5-mini',
          status: 'completed',
          output_text: '{"highlights":[]}',
          output: [
            {
              type: 'reasoning',
              summary: [
                {
                  type: 'summary_text',
                  text: 'Compared monitor failures against event bursts.',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 240,
            output_tokens: 60,
            total_tokens: 300,
            output_tokens_details: {
              reasoning_tokens: 22,
            },
          },
          error: null,
        }),
      },
    });

    const toolCalls: Array<Record<string, unknown>> = [];
    const openAiCalls: Array<Record<string, unknown>> = [];
    const result = await (service as any).refineWithAi(
      [makeHighlight()],
      makeContext(),
      '',
      toolCalls,
      openAiCalls,
    );

    expect(result).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      tool: 'ai.synthesis',
      ok: true,
    });
    expect(openAiCalls).toHaveLength(1);
    expect(openAiCalls[0]).toMatchObject({
      status: 'completed',
      model: 'gpt-5-mini',
    });
    expect(openAiCalls[0]?.reasoningSummary).toEqual([
      'Compared monitor failures against event bursts.',
    ]);
    expect(openAiCalls[0]?.usage).toMatchObject({
      inputTokens: 240,
      outputTokens: 60,
      reasoningTokens: 22,
      totalTokens: 300,
    });
  });

  it('tolerates wrapped JSON and coerces near-miss highlight fields', async () => {
    const { service, aiProviderService } = createService(true);
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockResolvedValue({
          id: 'resp_wrapped',
          model: 'gpt-5-mini',
          status: 'completed',
          output_text: [
            'Here is the requested JSON:',
            '```json',
            JSON.stringify({
              highlights: [
                {
                  title: 'Host pressure',
                  summary: 'Sustained CPU pressure detected.',
                  severity: 'WARNING',
                  category: 'host',
                  confidence: '0.91',
                  references: null,
                },
              ],
            }),
            '```',
          ].join('\n'),
          output: [],
          usage: null,
          error: null,
        }),
      },
    });

    const toolCalls: Array<Record<string, unknown>> = [];
    const openAiCalls: Array<Record<string, unknown>> = [];
    const result = await (service as any).refineWithAi(
      [makeHighlight('Original summary from heuristic draft')],
      makeContext(),
      '',
      toolCalls,
      openAiCalls,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
      title: 'Host pressure',
      summary: 'Sustained CPU pressure detected.',
      severity: 'warn',
      category: 'host',
      confidence: 0.91,
      recommendedActions: ['Inspect top processes'],
    });
    expect(toolCalls[0]).toMatchObject({
      tool: 'ai.synthesis',
      ok: true,
    });
    expect(openAiCalls[0]?.status).toBe('completed');
  });

  it('captures invalid output debug calls and redacts sensitive payload strings', async () => {
    const { service, aiProviderService } = createService(true);
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockResolvedValue({
          id: 'resp_invalid',
          model: 'gpt-5-mini',
          status: 'completed',
          output_text: '{}',
          output: [],
          usage: null,
          error: null,
        }),
      },
    });

    const toolCalls: Array<Record<string, unknown>> = [];
    const openAiCalls: Array<Record<string, unknown>> = [];
    await (service as any).refineWithAi(
      [
        makeHighlight(
          'authorization: Bearer abc.def.ghi password=letmein token:topsecret sk-abcdefghi',
        ),
      ],
      makeContext(),
      '',
      toolCalls,
      openAiCalls,
    );

    expect(openAiCalls).toHaveLength(1);
    expect(openAiCalls[0]?.status).toBe('invalid_output');
    expect(openAiCalls[0]?.error).toContain('highlights');
    const serializedRequest = JSON.stringify(openAiCalls[0]?.requestPayload ?? {});
    expect(serializedRequest).not.toContain('letmein');
    expect(serializedRequest).not.toContain('abc.def.ghi');
    expect(serializedRequest).toContain('[REDACTED');
  });

  it('captures failed openai debug calls when the request throws', async () => {
    const { service, aiProviderService } = createService(true);
    aiProviderService.getClient.mockResolvedValueOnce({
      responses: {
        create: vi.fn().mockRejectedValue(new Error('upstream timeout password=supersecret')),
      },
    });

    const toolCalls: Array<Record<string, unknown>> = [];
    const openAiCalls: Array<Record<string, unknown>> = [];
    await (service as any).refineWithAi(
      [makeHighlight()],
      makeContext(),
      '',
      toolCalls,
      openAiCalls,
    );

    expect(toolCalls[0]).toMatchObject({
      tool: 'ai.synthesis',
      ok: false,
    });
    expect(openAiCalls).toHaveLength(1);
    expect(openAiCalls[0]?.status).toBe('failed');
    expect(String(openAiCalls[0]?.error ?? '')).not.toContain('supersecret');
  });

  it('deletes a completed run and writes an audit record', async () => {
    const { service, prisma, auditService } = createService();
    prisma.dashboardAgentRun.findUnique.mockResolvedValueOnce({
      id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
      trigger: 'MANUAL',
      triggeredByUserId: null,
      startedAt: new Date('2026-03-07T12:00:00.000Z'),
      finishedAt: new Date('2026-03-07T12:00:03.000Z'),
      status: 'COMPLETED',
      findingCount: 1,
      highPriorityCount: 1,
      highlights: [],
      summary: makeRunSummaryWithDebug(),
      error: null,
    });
    prisma.dashboardAgentRun.delete.mockResolvedValueOnce({
      id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
      status: 'COMPLETED',
    });

    const result = await service.deleteRun('4f2026f5-58f6-4ef7-a53e-278fddf17de9', 'user-1');

    expect(result).toEqual({
      ok: true,
      deleted: true,
      runId: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
    });
    expect(prisma.dashboardAgentRun.delete).toHaveBeenCalledWith({
      where: { id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9' },
      select: {
        id: true,
        status: true,
      },
    });
    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        action: 'dashboard.agent.run.delete',
        targetId: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
        success: true,
      }),
    );
  });

  it('rejects deletion when the run does not exist', async () => {
    const { service, prisma } = createService();
    prisma.dashboardAgentRun.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.deleteRun('4f2026f5-58f6-4ef7-a53e-278fddf17de9', 'user-1'),
    ).rejects.toThrow('Dashboard agent run not found');

    expect(prisma.dashboardAgentRun.delete).not.toHaveBeenCalled();
  });

  it('rejects deletion for the active run even if the persisted row is not marked running', async () => {
    const { service, prisma } = createService();
    (service as any).activeRunId = '4f2026f5-58f6-4ef7-a53e-278fddf17de9';
    prisma.dashboardAgentRun.findUnique.mockResolvedValueOnce({
      id: '4f2026f5-58f6-4ef7-a53e-278fddf17de9',
      trigger: 'MANUAL',
      triggeredByUserId: null,
      startedAt: new Date('2026-03-07T12:00:00.000Z'),
      finishedAt: new Date('2026-03-07T12:00:03.000Z'),
      status: 'COMPLETED',
      findingCount: 1,
      highPriorityCount: 1,
      highlights: [],
      summary: makeRunSummaryWithDebug(),
      error: null,
    });

    await expect(
      service.deleteRun('4f2026f5-58f6-4ef7-a53e-278fddf17de9', 'user-1'),
    ).rejects.toThrow('Cannot delete a running dashboard agent run');

    expect(prisma.dashboardAgentRun.delete).not.toHaveBeenCalled();
  });
});

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the dashboard agent page route view.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import { formatTimeAgo, formatTimestamp } from '@/lib/time';
import { cn } from '@/lib/utils';
import type {
  DashboardAgentHighlight,
  DashboardAgentHighlightsResponse,
  DashboardAgentOpenAiCall,
  DashboardAgentRunDeleteResponse,
  DashboardAgentRunHistoryItem,
  DashboardAgentRunsResponse,
  DashboardAgentStatusResponse,
} from '@/types/api';

/**
 * Renders the dashboard agent page view.
 */
export function DashboardAgentPage() {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [debugConsoleOpen, setDebugConsoleOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['dashboard-agent-status'],
    queryFn: () => apiFetch<DashboardAgentStatusResponse>('/api/dashboard-agent/status'),
    refetchInterval: (query) => {
      const payload = query.state.data as DashboardAgentStatusResponse | undefined;
      return payload?.isRunning ? 3_000 : 15_000;
    },
  });

  const runsQuery = useQuery({
    queryKey: ['dashboard-agent-runs'],
    queryFn: () => apiFetch<DashboardAgentRunsResponse>('/api/dashboard-agent/runs?limit=20'),
    refetchInterval: (query) => {
      const payload = query.state.data as DashboardAgentRunsResponse | undefined;
      const activeStatus = payload?.runs[0]?.status;
      return activeStatus === 'RUNNING' ? 3_000 : 15_000;
    },
  });

  const highlightsQuery = useQuery({
    queryKey: ['dashboard-agent-highlights'],
    queryFn: () => apiFetch<DashboardAgentHighlightsResponse>('/api/dashboard-agent/highlights'),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!selectedRunId && runsQuery.data?.runs[0]?.id) {
      setSelectedRunId(runsQuery.data.runs[0].id);
      return;
    }

    if (
      selectedRunId &&
      runsQuery.data &&
      !runsQuery.data.runs.some((run) => run.id === selectedRunId)
    ) {
      setSelectedRunId(runsQuery.data.runs[0]?.id ?? null);
    }
  }, [runsQuery.data, selectedRunId]);

  const runNowMutation = useMutation({
    mutationFn: () =>
      apiFetch<DashboardAgentRunHistoryItem>('/api/dashboard-agent/run', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
        }),
      }),
    onSuccess: async (run) => {
      setSelectedRunId(run.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-agent-status'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-agent-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-agent-highlights'] }),
      ]);
    },
  });

  const deleteRunMutation = useMutation({
    mutationFn: (runId: string) =>
      apiFetch<DashboardAgentRunDeleteResponse>(`/api/dashboard-agent/runs/${runId}`, {
        method: 'DELETE',
        body: JSON.stringify({
          confirm: true,
        }),
      }),
    onSuccess: async (result) => {
      queryClient.setQueryData<DashboardAgentRunsResponse | undefined>(
        ['dashboard-agent-runs'],
        (current) => {
          if (!current) {
            return current;
          }
          return {
            runs: current.runs.filter((run) => run.id !== result.runId),
          };
        },
      );
      if (selectedRunId === result.runId) {
        setSelectedRunId(null);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard-agent-status'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-agent-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard-agent-highlights'] }),
      ]);
    },
  });

  const canDeleteRuns = true;
  const status = statusQuery.data;
  const runs = runsQuery.data?.runs ?? [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const openAiCalls = useMemo(
    () => extractOpenAiCalls(selectedRun?.summary ?? null),
    [selectedRun?.summary],
  );
  const highlights = useMemo(
    () => (highlightsQuery.data?.highlights ?? []).slice(0, 6),
    [highlightsQuery.data?.highlights],
  );
  const deletingRunId = deleteRunMutation.isPending ? deleteRunMutation.variables : null;
  const deleteRunError = deleteRunMutation.isError
    ? deleteRunMutation.error instanceof Error
      ? deleteRunMutation.error.message
      : 'Failed to delete dashboard-agent run.'
    : null;

  useEffect(() => {
    setDebugConsoleOpen(false);
  }, [selectedRun?.id]);

  /**
   * Handles delete run.
   */
  const handleDeleteRun = (run: DashboardAgentRunHistoryItem) => {
    const confirmed = window.confirm(
      `Delete dashboard-agent run ${run.id.slice(0, 8)} started ${formatTimestamp(run.startedAt)}?`,
    );
    if (!confirmed) {
      return;
    }
    deleteRunMutation.mutate(run.id);
  };

  if (statusQuery.isLoading || runsQuery.isLoading || highlightsQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (statusQuery.isError || runsQuery.isError || highlightsQuery.isError) {
    return <div className="text-sm text-rose-400">Failed to load Dashboard Agent data.</div>;
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <div className="min-w-0 space-y-4">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Dashboard Agent
                  {status?.isRunning && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs text-sky-200">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Running
                    </span>
                  )}
                </CardTitle>
                <CardDescription className="break-words">
                  Read-only background analysis loop that reviews homelab history, investigates
                  anomalies, and surfaces action-focused findings.
                </CardDescription>
              </div>
              <Button
                onClick={() => runNowMutation.mutate()}
                disabled={runNowMutation.isPending || status?.isRunning}
              >
                {runNowMutation.isPending ? 'Running...' : 'Run Now'}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
            <MetricLine label="Enabled" value={status?.enabled ? 'Yes' : 'No'} />
            <MetricLine label="Interval" value={status ? `${status.intervalSec}s` : '-'} />
            <MetricLine
              label="Next Scheduled"
              value={
                status?.nextScheduledRunAt
                  ? `${formatTimestamp(status.nextScheduledRunAt)} (${formatTimeAgo(status.nextScheduledRunAt)})`
                  : 'Disabled'
              }
            />
            <MetricLine
              label="Last Run"
              value={
                status?.lastRunAt
                  ? `${formatTimestamp(status.lastRunAt)} (${status.lastRunStatus ?? 'UNKNOWN'})`
                  : 'Never'
              }
            />
            {runNowMutation.isError && (
              <div className="text-xs text-rose-400 md:col-span-2 xl:col-span-4">
                Manual run request failed.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Latest Highlights
            </CardTitle>
            <CardDescription className="break-words">
              Highlights from run{' '}
              {highlightsQuery.data?.runId ? highlightsQuery.data.runId.slice(0, 8) : 'N/A'}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-2">
            {highlights.length === 0 && (
              <div className="text-sm text-muted-foreground">
                No highlights yet. Trigger a run to populate findings.
              </div>
            )}
            {highlights.map((highlight) => (
              <HighlightCard key={highlight.id} highlight={highlight} compact />
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Run History</CardTitle>
            <CardDescription>Recent dashboard-agent runs and status.</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-3">
            {runs.length === 0 ? (
              <div className="text-sm text-muted-foreground">No runs recorded yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="min-w-[44rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Findings</TableHead>
                      <TableHead>High Priority</TableHead>
                      <TableHead>Finished</TableHead>
                      <TableHead className="w-[1%] text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => {
                      const isDeleting = deletingRunId === run.id;
                      return (
                        <TableRow
                          key={run.id}
                          className={cn(
                            'cursor-pointer',
                            selectedRunId === run.id ? 'bg-secondary/40' : '',
                          )}
                          onClick={() => setSelectedRunId(run.id)}
                        >
                          <TableCell>
                            <div className="whitespace-nowrap text-xs text-muted-foreground">
                              {formatTimestamp(run.startedAt)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge className={statusBadgeClass(run.status)}>{run.status}</Badge>
                          </TableCell>
                          <TableCell>{run.trigger}</TableCell>
                          <TableCell>{run.findingCount}</TableCell>
                          <TableCell>{run.highPriorityCount}</TableCell>
                          <TableCell>
                            <div className="whitespace-nowrap text-xs text-muted-foreground">
                              {formatTimestamp(run.finishedAt ?? undefined)}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end">
                              {canDeleteRuns && run.status !== 'RUNNING' && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={deleteRunMutation.isPending}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleDeleteRun(run);
                                  }}
                                >
                                  {isDeleting ? (
                                    <>
                                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                      Deleting...
                                    </>
                                  ) : (
                                    <>
                                      <Trash2 className="mr-1 h-3 w-3" />
                                      Delete
                                    </>
                                  )}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {deleteRunError && <div className="text-xs text-rose-400">{deleteRunError}</div>}
          </CardContent>
        </Card>
      </div>

      <div className="min-w-0">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle>Selected Run Details</CardTitle>
            <CardDescription className="break-all">
              {selectedRun
                ? `${selectedRun.id} · ${formatTimestamp(selectedRun.startedAt)}`
                : 'Select a run from history.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 space-y-3">
            {!selectedRun && <div className="text-sm text-muted-foreground">No run selected.</div>}

            {selectedRun && selectedRun.error && (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                {selectedRun.error}
              </div>
            )}

            {selectedRun && (selectedRun.highlights ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground">
                No highlights captured for this run.
              </div>
            )}

            {selectedRun &&
              (selectedRun.highlights ?? []).map((highlight) => (
                <HighlightCard key={highlight.id} highlight={highlight} compact={false} />
              ))}

            {selectedRun && (
              <div className="min-w-0 space-y-3 rounded-md border border-border/60 bg-background/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">OpenAI Debug Console</div>
                    <div className="text-xs text-muted-foreground">
                      {openAiCalls.length} captured call{openAiCalls.length === 1 ? '' : 's'}.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDebugConsoleOpen((current) => !current)}
                  >
                    {debugConsoleOpen ? (
                      <ChevronDown className="mr-1 h-4 w-4" />
                    ) : (
                      <ChevronRight className="mr-1 h-4 w-4" />
                    )}
                    {debugConsoleOpen ? 'Collapse Debug Console' : 'Expand Debug Console'}
                  </Button>
                </div>

                {debugConsoleOpen && (
                  <div className="min-w-0 space-y-2">
                    {openAiCalls.length === 0 && (
                      <div className="text-xs text-muted-foreground">
                        No OpenAI calls were captured for this run.
                      </div>
                    )}
                    {openAiCalls.map((call) => (
                      <details
                        key={call.id}
                        className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-background/60 p-2"
                      >
                        <summary className="cursor-pointer list-none">
                          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                            <span className="break-all font-medium uppercase tracking-wide text-muted-foreground">
                              {call.step}
                            </span>
                            <Badge className={openAiStatusBadgeClass(call.status)}>
                              {openAiStatusLabel(call.status)}
                            </Badge>
                            <span className="break-all text-muted-foreground">{call.model}</span>
                            <span className="text-muted-foreground">
                              {call.durationMs === null ? 'Duration n/a' : `${call.durationMs}ms`}
                            </span>
                          </div>
                        </summary>
                        <div className="mt-2 min-w-0 space-y-2 text-xs">
                          {call.error && (
                            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-rose-200">
                              {call.error}
                            </div>
                          )}
                          {call.reasoningSummary.length > 0 && (
                            <div>
                              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                                Reasoning summary
                              </div>
                              <div className="break-words rounded-md border border-border/60 bg-background/70 p-2">
                                {call.reasoningSummary.join(' | ')}
                              </div>
                            </div>
                          )}
                          {call.usage && (
                            <div className="grid gap-2 sm:grid-cols-2">
                              <MetricLine
                                label="Input Tokens"
                                value={displayCount(call.usage.inputTokens)}
                              />
                              <MetricLine
                                label="Output Tokens"
                                value={displayCount(call.usage.outputTokens)}
                              />
                              <MetricLine
                                label="Reasoning Tokens"
                                value={displayCount(call.usage.reasoningTokens)}
                              />
                              <MetricLine
                                label="Total Tokens"
                                value={displayCount(call.usage.totalTokens)}
                              />
                            </div>
                          )}
                          {call.outputText && (
                            <DebugJsonBlock label="Model Output Text" value={call.outputText} />
                          )}
                          <DebugJsonBlock label="Request Payload" value={call.requestPayload} />
                          <DebugJsonBlock label="Response Payload" value={call.responsePayload} />
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Renders the highlight card view.
 */
function HighlightCard({
  highlight,
  compact,
}: {
  highlight: DashboardAgentHighlight;
  compact: boolean;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border/60 bg-background/40 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="break-words text-sm font-medium">{highlight.title}</div>
        <Badge className={severityBadgeClass(highlight.severity)}>
          {highlight.severity.toUpperCase()}
        </Badge>
        <Badge className="border border-border/50 bg-transparent text-[10px] uppercase tracking-wide text-muted-foreground">
          {highlight.category}
        </Badge>
        <div className="text-[11px] text-muted-foreground">
          Confidence {Math.round(highlight.confidence * 100)}%
        </div>
        {highlight.eventEmitted && (
          <Badge className="border border-amber-400/50 bg-transparent text-[10px] uppercase tracking-wide text-amber-300">
            Event emitted
          </Badge>
        )}
      </div>
      <div className="mt-1 break-words text-xs text-muted-foreground">{highlight.summary}</div>

      {(highlight.investigation.length > 0 ||
        (!compact && highlight.recommendedActions.length > 0)) && (
        <div className="mt-2 space-y-1 text-xs">
          {highlight.investigation.length > 0 && (
            <div className="break-words">
              <span className="text-muted-foreground">Investigation: </span>
              <span>{highlight.investigation.join(' | ')}</span>
            </div>
          )}
          {!compact && highlight.recommendedActions.length > 0 && (
            <div className="break-words">
              <span className="text-muted-foreground">Recommended: </span>
              <span>{highlight.recommendedActions.join(' | ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders the metric line view.
 */
function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/50 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium">{value}</div>
    </div>
  );
}

/**
 * Implements severity badge class.
 */
function severityBadgeClass(severity: DashboardAgentHighlight['severity']) {
  if (severity === 'critical') {
    return 'bg-rose-500/15 text-rose-200 border border-rose-400/40';
  }
  if (severity === 'warn') {
    return 'bg-amber-500/15 text-amber-200 border border-amber-400/40';
  }
  return 'bg-sky-500/15 text-sky-200 border border-sky-400/40';
}

/**
 * Implements status badge class.
 */
function statusBadgeClass(status: DashboardAgentRunHistoryItem['status']) {
  if (status === 'FAILED') {
    return 'bg-rose-500/15 text-rose-200 border border-rose-400/40';
  }
  if (status === 'RUNNING') {
    return 'bg-sky-500/15 text-sky-200 border border-sky-400/40';
  }
  return 'bg-emerald-500/15 text-emerald-200 border border-emerald-400/40';
}

/**
 * Implements open ai status badge class.
 */
function openAiStatusBadgeClass(status: DashboardAgentOpenAiCall['status']) {
  if (status === 'failed') {
    return 'bg-rose-500/15 text-rose-200 border border-rose-400/40';
  }
  if (status === 'invalid_output') {
    return 'bg-amber-500/15 text-amber-200 border border-amber-400/40';
  }
  return 'bg-emerald-500/15 text-emerald-200 border border-emerald-400/40';
}

/**
 * Implements open ai status label.
 */
function openAiStatusLabel(status: DashboardAgentOpenAiCall['status']) {
  if (status === 'invalid_output') {
    return 'INVALID OUTPUT';
  }
  return status.toUpperCase();
}

/**
 * Implements display count.
 */
function displayCount(value: number | null) {
  return value === null ? '-' : String(value);
}

/**
 * Implements extract open ai calls.
 */
function extractOpenAiCalls(summary: DashboardAgentRunHistoryItem['summary']) {
  const record = toRecord(summary);
  if (!record || !Array.isArray(record.openAiCalls)) {
    return [] as DashboardAgentOpenAiCall[];
  }

  return record.openAiCalls
    .map((entry, index) => normalizeOpenAiCall(entry, index))
    .filter((entry): entry is DashboardAgentOpenAiCall => entry !== null);
}

/**
 * Implements normalize open ai call.
 */
function normalizeOpenAiCall(entry: unknown, index: number): DashboardAgentOpenAiCall | null {
  const record = toRecord(entry);
  if (!record) {
    return null;
  }

  const status = normalizeOpenAiStatus(record.status);
  if (!status) {
    return null;
  }

  const usageRecord = toRecord(record.usage);
  return {
    id:
      typeof record.id === 'string' && record.id.trim().length > 0
        ? record.id
        : `openai-call-${index + 1}`,
    step:
      typeof record.step === 'string' && record.step.trim().length > 0
        ? record.step
        : 'unknown_step',
    model:
      typeof record.model === 'string' && record.model.trim().length > 0 ? record.model : 'unknown',
    status,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    durationMs:
      typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
        ? record.durationMs
        : null,
    requestPayload: record.requestPayload ?? null,
    responsePayload: record.responsePayload ?? null,
    outputText: typeof record.outputText === 'string' ? record.outputText : null,
    reasoningSummary: Array.isArray(record.reasoningSummary)
      ? record.reasoningSummary.filter((item): item is string => typeof item === 'string')
      : [],
    usage: usageRecord
      ? {
          inputTokens: toNullableNumber(usageRecord.inputTokens),
          outputTokens: toNullableNumber(usageRecord.outputTokens),
          reasoningTokens: toNullableNumber(usageRecord.reasoningTokens),
          totalTokens: toNullableNumber(usageRecord.totalTokens),
        }
      : null,
    error: typeof record.error === 'string' ? record.error : null,
  };
}

/**
 * Implements normalize open ai status.
 */
function normalizeOpenAiStatus(value: unknown): DashboardAgentOpenAiCall['status'] | null {
  if (value === 'completed' || value === 'invalid_output' || value === 'failed') {
    return value;
  }
  return null;
}

/**
 * Implements to nullable number.
 */
function toNullableNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
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

/**
 * Renders the debug json block view.
 */
function DebugJsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/70 p-2 text-xs">
        {toJsonString(value)}
      </pre>
    </div>
  );
}

/**
 * Implements to json string.
 */
function toJsonString(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

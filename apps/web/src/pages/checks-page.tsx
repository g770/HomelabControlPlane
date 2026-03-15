/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the checks page route view.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { HealthBadge } from '@/components/health-badge';
import { apiFetch } from '@/lib/api';
import { PageSkeleton } from '@/components/page-skeleton';
import type {
  MonitorDefinition,
  MonitorParseResponse,
  MonitorSuggestion,
  MonitorSuggestionsResponse,
  MonitorType,
} from '@/types/api';

// Monitors page: CRUD monitor management plus AI parse/suggestion workflows.
type MonitorRecord = {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  expectedStatus: number | null;
  intervalSec: number;
  timeoutMs: number;
  keyword: string | null;
  enabled: boolean;
  hostId: string | null;
  serviceId: string | null;
  host?: {
    hostname?: string | null;
  } | null;
  service?: {
    name?: string | null;
  } | null;
  results?: Array<{
    status?: string | null;
  }>;
};

type MonitorFormState = {
  name: string;
  type: MonitorType;
  target: string;
  expectedStatus: string;
  intervalSec: string;
  timeoutMs: string;
  keyword: string;
  enabled: boolean;
  hostId: string;
  serviceId: string;
};

type HostOption = {
  id: string;
  name: string;
};

type ServiceOption = {
  id: string;
  name: string;
};

type MonitorStatusFilter = 'all' | 'failing';

const defaultForm: MonitorFormState = {
  name: '',
  type: 'HTTP',
  target: 'https://example.com',
  expectedStatus: '200',
  intervalSec: '60',
  timeoutMs: '2000',
  keyword: '',
  enabled: true,
  hostId: '',
  serviceId: '',
};

/**
 * Renders the monitors page view.
 */
export function MonitorsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [form, setForm] = useState<MonitorFormState>(defaultForm);
  const [editingMonitorId, setEditingMonitorId] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const statusFilter = parseMonitorStatusFilter(searchParams.get('status'));

  const monitorsQuery = useQuery({
    queryKey: ['checks'],
    queryFn: () => apiFetch<MonitorRecord[]>('/api/checks'),
  });

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => apiFetch<Array<Record<string, unknown>>>('/api/hosts'),
  });

  const servicesQuery = useQuery({
    queryKey: ['services'],
    queryFn: () => apiFetch<Array<Record<string, unknown>>>('/api/services'),
  });

  const suggestionsQuery = useQuery({
    queryKey: ['monitor-suggestions'],
    queryFn: () => apiFetch<MonitorSuggestionsResponse>('/api/checks/ai/suggestions'),
  });

  const hostOptions = useMemo<HostOption[]>(
    () =>
      (hostsQuery.data ?? [])
        .map((host) => ({
          id: typeof host.id === 'string' ? host.id : '',
          name:
            typeof host.hostname === 'string' && host.hostname.trim().length > 0
              ? host.hostname
              : String(host.id ?? ''),
        }))
        .filter((host) => host.id.length > 0),
    [hostsQuery.data],
  );

  const serviceOptions = useMemo<ServiceOption[]>(
    () =>
      (servicesQuery.data ?? [])
        .map((service) => ({
          id: typeof service.id === 'string' ? service.id : '',
          name:
            typeof service.name === 'string' && service.name.trim().length > 0
              ? service.name
              : String(service.id ?? ''),
        }))
        .filter((service) => service.id.length > 0),
    [servicesQuery.data],
  );

  const hostNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const host of hostOptions) {
      map.set(host.id, host.name);
    }
    return map;
  }, [hostOptions]);

  const serviceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const service of serviceOptions) {
      map.set(service.id, service.name);
    }
    return map;
  }, [serviceOptions]);

  const createMutation = useMutation({
    mutationFn: (payload: MonitorDefinition) =>
      apiFetch('/api/checks', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setForm(defaultForm);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['checks'] });
      void queryClient.invalidateQueries({ queryKey: ['monitor-suggestions'] });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : 'Failed to create monitor.');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: MonitorDefinition }) =>
      apiFetch(`/api/checks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setEditingMonitorId(null);
      setForm(defaultForm);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['checks'] });
      void queryClient.invalidateQueries({ queryKey: ['monitor-suggestions'] });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : 'Failed to update monitor.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/checks/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      if (editingMonitorId) {
        setEditingMonitorId(null);
        setForm(defaultForm);
      }
      void queryClient.invalidateQueries({ queryKey: ['checks'] });
      void queryClient.invalidateQueries({ queryKey: ['monitor-suggestions'] });
    },
  });

  const parseMutation = useMutation({
    mutationFn: (input: { description: string; hostId?: string; serviceId?: string }) =>
      apiFetch<MonitorParseResponse>('/api/checks/ai/parse', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (response) => {
      applyDraftToForm(response.monitor);
      const confidenceText =
        typeof response.confidence === 'number' ? ` (${response.confidence}% confidence)` : '';
      const rationaleText = response.rationale ? ` ${response.rationale}` : '';
      const sourceText = response.generatedByAi
        ? 'AI parsed monitor draft.'
        : 'Heuristic monitor draft generated.';
      setAiNotice(`${sourceText}${confidenceText}${rationaleText}`);
      setAiWarnings(response.warnings ?? []);
      setFormError(null);
    },
    onError: (error) => {
      setAiNotice(null);
      setAiWarnings([]);
      setFormError(error instanceof Error ? error.message : 'Failed to parse monitor description.');
    },
  });

  if (monitorsQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (monitorsQuery.isError || !monitorsQuery.data) {
    return <div className="text-sm text-rose-400">Failed to load monitors.</div>;
  }

  const activeSave = createMutation.isPending || updateMutation.isPending;

  /**
   * Implements submit form.
   */
  const submitForm = () => {
    const built = buildMonitorPayload(form);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }

    setFormError(null);
    if (editingMonitorId) {
      updateMutation.mutate({ id: editingMonitorId, payload: built.payload });
      return;
    }

    createMutation.mutate(built.payload);
  };

  /**
   * Implements start editing monitor.
   */
  const startEditingMonitor = (monitor: MonitorRecord) => {
    setEditingMonitorId(monitor.id);
    setForm(toFormState(monitor));
    setFormError(null);
    setAiNotice(null);
    setAiWarnings([]);
  };

  /**
   * Creates from suggestion.
   */
  const createFromSuggestion = (suggestion: MonitorSuggestion) => {
    const payload = draftToMonitorPayload(suggestion);
    createMutation.mutate(payload);
  };

  // Uses browser confirmation because deletes are destructive and immediate.
  const deleteMonitor = (monitor: MonitorRecord) => {
    const confirmed = window.confirm(`Delete monitor "${monitor.name}"?`);
    if (!confirmed) {
      return;
    }
    deleteMutation.mutate(monitor.id);
  };

  const sortedMonitors = [...monitorsQuery.data].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const statusCounts = {
    all: sortedMonitors.length,
    failing: sortedMonitors.filter((monitor) => isMonitorFailing(monitor)).length,
  };
  const visibleMonitors =
    statusFilter === 'failing'
      ? sortedMonitors.filter((monitor) => isMonitorFailing(monitor))
      : sortedMonitors;

  /**
   * Sets status filter.
   */
  const setStatusFilter = (next: MonitorStatusFilter) => {
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'all') {
      nextParams.delete('status');
    } else {
      nextParams.set('status', next);
    }
    setSearchParams(nextParams);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{editingMonitorId ? 'Edit Monitor' : 'Create Monitor'}</CardTitle>
          <CardDescription>
            Define monitor type, target, cadence, and scope. You can also describe the monitor in
            plain English and let AI populate the form.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-border/60 p-3">
            <div className="mb-2 text-sm font-medium">Describe Monitor in English</div>
            <div className="grid gap-2">
              <Textarea
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder='Example: "Check https://grafana.local every 30 seconds, timeout 2s, expect status 200."'
                className="min-h-24"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={parseMutation.isPending || draftDescription.trim().length === 0}
                  onClick={() =>
                    parseMutation.mutate({
                      description: draftDescription.trim(),
                      hostId: form.hostId || undefined,
                      serviceId: form.serviceId || undefined,
                    })
                  }
                >
                  {parseMutation.isPending ? 'Parsing...' : 'Populate Fields with AI'}
                </Button>
                {aiNotice && <span className="text-xs text-muted-foreground">{aiNotice}</span>}
              </div>
              {aiWarnings.length > 0 && (
                <div className="space-y-1 text-xs text-amber-400">
                  {aiWarnings.map((warning, index) => (
                    <div key={`${warning}-${index}`}>{warning}</div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitForm();
            }}
          >
            <div className="space-y-1">
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Monitor name"
                required
              />
              <p className="text-xs text-muted-foreground">
                Friendly name shown in monitor lists and alerts.
              </p>
            </div>
            <div className="space-y-1">
              <Select
                value={form.type}
                onChange={(event) => {
                  const nextType = event.target.value as MonitorType;
                  setForm((current) => ({
                    ...current,
                    type: nextType,
                    expectedStatus: nextType === 'HTTP' ? current.expectedStatus || '200' : '',
                    keyword: nextType === 'HTTP' ? current.keyword : '',
                  }));
                }}
              >
                <option value="HTTP">HTTP(S)</option>
                <option value="TCP">TCP</option>
                <option value="ICMP">ICMP</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                Select protocol: HTTP, TCP, or ICMP reachability checks.
              </p>
            </div>
            <div className="space-y-1">
              <Input
                value={form.target}
                onChange={(event) =>
                  setForm((current) => ({ ...current, target: event.target.value }))
                }
                placeholder={targetPlaceholder(form.type)}
                required
              />
              <p className="text-xs text-muted-foreground">
                HTTP uses URL, TCP uses host:port, ICMP uses host or IP.
              </p>
            </div>
            <div className="space-y-1">
              <Input
                value={form.intervalSec}
                onChange={(event) =>
                  setForm((current) => ({ ...current, intervalSec: event.target.value }))
                }
                placeholder="Interval (sec)"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">Run frequency in seconds (10-3600).</p>
            </div>
            <div className="space-y-1">
              <Input
                value={form.timeoutMs}
                onChange={(event) =>
                  setForm((current) => ({ ...current, timeoutMs: event.target.value }))
                }
                placeholder="Timeout (ms)"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">
                Maximum request time in milliseconds (100-30000).
              </p>
            </div>
            <div className="space-y-1">
              {form.type === 'HTTP' ? (
                <Input
                  value={form.expectedStatus}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, expectedStatus: event.target.value }))
                  }
                  placeholder="Expected status"
                  inputMode="numeric"
                />
              ) : (
                <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  Expected status applies to HTTP monitors only.
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Expected HTTP response code (100-599), or leave blank.
              </p>
            </div>
            <div className="space-y-1">
              {form.type === 'HTTP' ? (
                <Input
                  value={form.keyword}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, keyword: event.target.value }))
                  }
                  placeholder='Keyword (optional, e.g. "healthy")'
                />
              ) : (
                <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  Body keyword matching applies to HTTP monitors only.
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Optional body text required for HTTP checks to pass.
              </p>
            </div>
            <div className="space-y-1">
              <Select
                value={form.hostId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, hostId: event.target.value }))
                }
              >
                <option value="">Attach to host (optional)</option>
                {hostOptions.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Associate this monitor with a host for context and filtering.
              </p>
            </div>
            <div className="space-y-1">
              <Select
                value={form.serviceId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, serviceId: event.target.value }))
                }
              >
                <option value="">Attach to service (optional)</option>
                {serviceOptions.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Associate this monitor with a service for context and filtering.
              </p>
            </div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                Enabled
              </label>
              <p className="text-xs text-muted-foreground">
                Disable to keep configuration without running scheduled checks.
              </p>
            </div>
            <div className="md:col-span-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={activeSave}>
                  {activeSave
                    ? 'Saving...'
                    : editingMonitorId
                      ? 'Update Monitor'
                      : 'Create Monitor'}
                </Button>
                {editingMonitorId && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setEditingMonitorId(null);
                      setForm(defaultForm);
                      setFormError(null);
                    }}
                  >
                    Cancel Edit
                  </Button>
                )}
              </div>
              {formError && <p className="mt-2 text-sm text-rose-400">{formError}</p>}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>Suggested Monitors</CardTitle>
            <CardDescription>
              Recommendations generated from your discovered hosts/services, current monitors,
              alerts, and recent events.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void suggestionsQuery.refetch()}
          >
            Refresh Suggestions
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {suggestionsQuery.isLoading && (
            <div className="text-muted-foreground">Generating suggestions...</div>
          )}
          {suggestionsQuery.isError && (
            <div className="text-rose-400">Failed to load monitor suggestions.</div>
          )}
          {!suggestionsQuery.isLoading && !suggestionsQuery.isError && suggestionsQuery.data && (
            <>
              <div className="text-xs text-muted-foreground">
                {suggestionsQuery.data.generatedByAi ? 'AI suggestions' : 'Heuristic suggestions'}
                {' · '}
                {new Date(suggestionsQuery.data.generatedAt).toLocaleString()}
              </div>
              {suggestionsQuery.data.warnings.map((warning, index) => (
                <div key={`${warning}-${index}`} className="text-xs text-amber-400">
                  {warning}
                </div>
              ))}
              {suggestionsQuery.data.suggestions.length === 0 && (
                <div className="rounded-md border border-dashed border-border/60 p-3 text-muted-foreground">
                  No suggestions available right now.
                </div>
              )}
              {suggestionsQuery.data.suggestions.map((suggestion) => (
                <div key={suggestion.id} className="rounded-md border border-border/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{suggestion.name}</div>
                      <div className="text-muted-foreground">
                        {suggestion.type} {suggestion.target}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        interval={suggestion.intervalSec}s timeout={suggestion.timeoutMs}ms
                        {suggestion.expectedStatus ? ` status=${suggestion.expectedStatus}` : ''}
                        {suggestion.keyword ? ` keyword="${suggestion.keyword}"` : ''}
                      </div>
                      {(suggestion.hostId || suggestion.serviceId) && (
                        <div className="text-xs text-muted-foreground">
                          {suggestion.hostId
                            ? `host: ${hostNameById.get(suggestion.hostId) ?? suggestion.hostId}`
                            : ''}
                          {suggestion.hostId && suggestion.serviceId ? ' · ' : ''}
                          {suggestion.serviceId
                            ? `service: ${serviceNameById.get(suggestion.serviceId) ?? suggestion.serviceId}`
                            : ''}
                        </div>
                      )}
                      {suggestion.rationale && (
                        <div className="text-xs text-muted-foreground">{suggestion.rationale}</div>
                      )}
                    </div>
                    {typeof suggestion.confidence === 'number' && (
                      <span className="rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground">
                        {suggestion.confidence}%
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => applyDraftToForm(suggestion)}
                    >
                      Use in Form
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={createMutation.isPending}
                      onClick={() => createFromSuggestion(suggestion)}
                    >
                      Create Monitor
                    </Button>
                  </div>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Network Monitors</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Button
              type="button"
              size="sm"
              variant={statusFilter === 'all' ? 'secondary' : 'outline'}
              onClick={() => setStatusFilter('all')}
            >
              /** * Handles all. */ All ({statusCounts.all})
            </Button>
            <Button
              type="button"
              size="sm"
              variant={statusFilter === 'failing' ? 'secondary' : 'outline'}
              onClick={() => setStatusFilter('failing')}
            >
              /** * Handles failing. */ Failing ({statusCounts.failing})
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {visibleMonitors.map((monitor) => {
            const latestStatus = monitor.results?.[0]?.status;
            const badgeStatus = !monitor.enabled ? 'WARN' : latestStatus === 'DOWN' ? 'CRIT' : 'OK';
            return (
              <div key={monitor.id} className="rounded-md border border-border/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link to={`/monitors/${monitor.id}`} className="font-medium">
                    {monitor.name}
                  </Link>
                  <HealthBadge status={badgeStatus} />
                </div>
                <div className="text-muted-foreground">
                  {monitor.type} {monitor.target} interval={monitor.intervalSec}s timeout=
                  {monitor.timeoutMs}ms
                  {monitor.expectedStatus ? ` status=${monitor.expectedStatus}` : ''}
                  {monitor.keyword ? ` keyword="${monitor.keyword}"` : ''}
                </div>
                {(monitor.host || monitor.service) && (
                  <div className="text-xs text-muted-foreground">
                    {monitor.host ? `host: ${monitor.host.hostname ?? '-'}` : ''}
                    {monitor.host && monitor.service ? ' · ' : ''}
                    {monitor.service ? `service: ${monitor.service.name ?? '-'}` : ''}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => startEditingMonitor(monitor)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMonitor(monitor)}
                  >
                    Delete
                  </Button>
                  <Button type="button" variant="ghost" size="sm" asChild>
                    <Link to={`/monitors/${monitor.id}`}>Open</Link>
                  </Button>
                </div>
              </div>
            );
          })}
          {visibleMonitors.length === 0 && (
            <div className="text-muted-foreground">No monitors match the current filter.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  /**
   * Implements apply draft to form.
   */
  function applyDraftToForm(draft: MonitorDefinition | MonitorSuggestion) {
    setEditingMonitorId(null);
    setForm({
      name: draft.name,
      type: draft.type,
      target: draft.target,
      expectedStatus: typeof draft.expectedStatus === 'number' ? String(draft.expectedStatus) : '',
      intervalSec: String(draft.intervalSec),
      timeoutMs: String(draft.timeoutMs),
      keyword: draft.keyword ?? '',
      enabled: Boolean(draft.enabled),
      hostId: draft.hostId ?? '',
      serviceId: draft.serviceId ?? '',
    });
  }
}

// Converts persisted monitor shape into editable form values.
function toFormState(monitor: MonitorRecord): MonitorFormState {
  return {
    name: monitor.name,
    type: monitor.type,
    target: monitor.target,
    expectedStatus:
      typeof monitor.expectedStatus === 'number' ? String(monitor.expectedStatus) : '',
    intervalSec: String(monitor.intervalSec),
    timeoutMs: String(monitor.timeoutMs),
    keyword: monitor.keyword ?? '',
    enabled: monitor.enabled,
    hostId: monitor.hostId ?? '',
    serviceId: monitor.serviceId ?? '',
  };
}

/**
 * Implements target placeholder.
 */
function targetPlaceholder(type: MonitorType) {
  if (type === 'HTTP') {
    return 'https://service.local/health';
  }
  if (type === 'TCP') {
    return 'service.local:443';
  }
  return 'host-or-ip';
}

/**
 * Builds monitor payload.
 */
function buildMonitorPayload(
  form: MonitorFormState,
): { ok: true; payload: MonitorDefinition } | { ok: false; error: string } {
  // Mirrors backend bounds so obvious errors are caught before network roundtrip.
  const name = form.name.trim();
  if (!name) {
    return { ok: false, error: 'Name is required.' };
  }

  const target = form.target.trim();
  if (!target) {
    return { ok: false, error: 'Target is required.' };
  }

  const intervalSec = Number(form.intervalSec);
  if (!Number.isFinite(intervalSec) || intervalSec < 10 || intervalSec > 3600) {
    return { ok: false, error: 'Interval must be between 10 and 3600 seconds.' };
  }

  const timeoutMs = Number(form.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    return { ok: false, error: 'Timeout must be between 100 and 30000 ms.' };
  }

  let expectedStatus: number | undefined;
  if (form.type === 'HTTP') {
    if (form.expectedStatus.trim().length > 0) {
      expectedStatus = Number(form.expectedStatus);
      if (!Number.isFinite(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
        return { ok: false, error: 'Expected status must be between 100 and 599.' };
      }
    }
  }

  return {
    ok: true,
    payload: {
      name,
      type: form.type,
      target,
      expectedStatus,
      intervalSec: Math.round(intervalSec),
      timeoutMs: Math.round(timeoutMs),
      keyword:
        form.type === 'HTTP' && form.keyword.trim().length > 0 ? form.keyword.trim() : undefined,
      enabled: form.enabled,
      hostId: form.hostId || undefined,
      serviceId: form.serviceId || undefined,
    },
  };
}

/**
 * Implements draft to monitor payload.
 */
function draftToMonitorPayload(suggestion: MonitorSuggestion): MonitorDefinition {
  return {
    name: suggestion.name,
    type: suggestion.type,
    target: suggestion.target,
    expectedStatus: suggestion.expectedStatus,
    intervalSec: suggestion.intervalSec,
    timeoutMs: suggestion.timeoutMs,
    keyword: suggestion.keyword,
    enabled: suggestion.enabled,
    hostId: suggestion.hostId,
    serviceId: suggestion.serviceId,
  };
}

/**
 * Parses monitor status filter.
 */
function parseMonitorStatusFilter(raw: string | null): MonitorStatusFilter {
  if (raw === 'failing') {
    return raw;
  }
  return 'all';
}

/**
 * Checks whether monitor failing.
 */
function isMonitorFailing(monitor: MonitorRecord) {
  if (!monitor.enabled) {
    return false;
  }
  const latestStatus = monitor.results?.[0]?.status;
  return latestStatus === 'DOWN';
}

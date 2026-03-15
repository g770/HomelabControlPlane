/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the alerts page route view.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api';
import { PageSkeleton } from '@/components/page-skeleton';
import type {
  AlertCatalogResponse,
  AlertCheckCondition,
  AlertCheckMode,
  AlertComparator,
  AlertCondition,
  AlertConditionMatch,
  AlertEventCountCondition,
  AlertHostMetricCondition,
  AlertIncidentsResponse,
  AlertHomelabMetricCondition,
  AlertIncident,
  AlertParseResponse,
  AlertPreviewIncident,
  AlertPreviewResponse,
  AlertReducer,
  AlertRuleDraft,
  AlertRuleMutationPayload,
  AlertRuleRecord,
  AlertRulesResponse,
  AlertScopeEntity,
  AlertStateCondition,
} from '@/types/api';

const fallbackComparators: AlertComparator[] = ['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'];
const fallbackReducers: AlertReducer[] = ['latest', 'avg', 'min', 'max'];
const conditionKinds = ['host_metric', 'homelab_metric', 'check', 'state', 'event_count'] as const;
const matchModes: AlertConditionMatch[] = ['ALL', 'ANY'];
const statusFilters = ['open', 'all', 'resolved'] as const;
const scopeEntities: AlertScopeEntity[] = ['host', 'check', 'service', 'homelab'];

type ConditionKind = (typeof conditionKinds)[number];
type StatusFilter = (typeof statusFilters)[number];

/**
 * Creates default condition.
 */
function createDefaultCondition(kind: ConditionKind = 'host_metric'): AlertCondition {
  if (kind === 'homelab_metric') {
    return {
      kind,
      metric: 'activeAlerts',
      comparator: 'GTE',
      threshold: 1,
    } satisfies AlertHomelabMetricCondition;
  }
  if (kind === 'check') {
    return {
      kind,
      mode: 'consecutive_failures',
      threshold: 3,
      sampleSize: 5,
      windowMinutes: 15,
    } satisfies AlertCheckCondition;
  }
  if (kind === 'state') {
    return {
      kind,
      target: 'host_offline',
      staleMinutes: 5,
    } satisfies AlertStateCondition;
  }
  if (kind === 'event_count') {
    return {
      kind,
      comparator: 'GTE',
      threshold: 1,
      windowMinutes: 15,
      eventType: '',
      severity: 'ERROR',
    } satisfies AlertEventCountCondition;
  }

  return {
    kind: 'host_metric',
    metric: 'cpuPct',
    comparator: 'GTE',
    threshold: 90,
    reducer: 'avg',
    windowMinutes: 15,
  } satisfies AlertHostMetricCondition;
}

/**
 * Creates default rule draft.
 */
function createDefaultRuleDraft(): AlertRuleDraft {
  return {
    name: 'High CPU sustained',
    description: 'Alert when average CPU stays above 90% for 15 minutes.',
    enabled: false,
    spec: {
      scope: {
        entity: 'host',
        hostIds: [],
        serviceIds: [],
        checkIds: [],
        tags: [],
      },
      conditions: {
        match: 'ALL',
        items: [createDefaultCondition('host_metric')],
      },
      evaluation: {
        pendingMinutes: 5,
        recoveryMinutes: 2,
        noDataBehavior: 'KEEP_STATE',
      },
      severity: 'ERROR',
      labels: {
        team: 'ops',
      },
      delivery: {
        routeIds: [],
        repeatMinutes: 60,
        sendResolved: true,
      },
    },
  };
}

/**
 * Implements format timestamp.
 */
function formatTimestamp(value: string | null) {
  if (!value) {
    return 'Not recorded';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

/**
 * Implements labels to text.
 */
function labelsToText(labels: Record<string, string>) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Parses labels.
 */
function parseLabels(input: string) {
  const labels: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [key, ...rest] = trimmed.split('=');
    const normalizedKey = key?.trim() ?? '';
    const normalizedValue = rest.join('=').trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    labels[normalizedKey] = normalizedValue;
  }
  return labels;
}

/**
 * Implements csv to list.
 */
function csvToList(input: string) {
  return input
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Implements list to csv.
 */
function listToCsv(values: string[] | undefined) {
  return values?.join(', ') ?? '';
}

/**
 * Implements normalize rule draft.
 */
function normalizeRuleDraft(
  rule: AlertRuleDraft,
  labelsText: string,
  tagsText: string,
): AlertRuleDraft {
  const description = rule.description?.trim();

  return {
    ...rule,
    description: description ? description : undefined,
    name: rule.name.trim(),
    spec: {
      ...rule.spec,
      scope: {
        ...rule.spec.scope,
        tags: csvToList(tagsText),
      },
      labels: parseLabels(labelsText),
    },
  };
}

/**
 * Implements to rule payload.
 */
function toRulePayload(
  rule: AlertRuleDraft,
  labelsText: string,
  tagsText: string,
  enabled: boolean,
): AlertRuleMutationPayload {
  const normalized = normalizeRuleDraft(rule, labelsText, tagsText);

  return {
    confirm: true,
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    enabled,
    spec: normalized.spec,
  };
}

/**
 * Gets condition kind.
 */
function getConditionKind(condition: AlertCondition): ConditionKind {
  return condition.kind;
}

/**
 * Implements describe rule.
 */
function describeRule(rule: AlertRuleRecord) {
  const count = rule.spec.conditions.items.length;
  const scope = rule.spec.scope.entity;
  return `${count} condition${count === 1 ? '' : 's'} on ${scope}`;
}

/**
 * Implements incident state tone.
 */
function incidentStateTone(state: AlertIncident['state']) {
  if (state === 'FIRING') {
    return 'border-rose-500/40 bg-rose-500/10 text-rose-100';
  }
  if (state === 'PENDING') {
    return 'border-amber-500/40 bg-amber-500/10 text-amber-100';
  }
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100';
}

/**
 * Implements incident state label.
 */
function incidentStateLabel(state: AlertIncident['state']) {
  if (state === 'FIRING') {
    return 'Firing';
  }
  if (state === 'PENDING') {
    return 'Pending';
  }
  return 'Resolved';
}

/**
 * Implements preview entity name.
 */
function previewEntityName(incident: AlertPreviewIncident) {
  return incident.host?.name ?? incident.service?.name ?? incident.check?.name ?? 'Homelab';
}

/**
 * Implements format preview values.
 */
function formatPreviewValues(values: Record<string, unknown>) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return null;
  }

  return entries
    .map(([key, value]) => {
      if (value === null || value === undefined) {
        return `${key}=n/a`;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${value}`;
      }
      return `${key}=${JSON.stringify(value)}`;
    })
    .join(' | ');
}

/**
 * Renders the alerts page view.
 */
export function AlertsPage() {
  const queryClient = useQueryClient();
  const [builder, setBuilder] = useState<AlertRuleDraft>(createDefaultRuleDraft);
  const [labelsText, setLabelsText] = useState(labelsToText(createDefaultRuleDraft().spec.labels));
  const [tagsText, setTagsText] = useState('');
  const [aiPrompt, setAiPrompt] = useState(
    'Alert when any host stays above 90% CPU for 15 minutes.',
  );
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [conditionToAdd, setConditionToAdd] = useState<ConditionKind>('host_metric');

  const incidentsQuery = useQuery({
    queryKey: ['alerts-incidents'],
    queryFn: () => apiFetch<AlertIncidentsResponse>('/api/alerts/incidents'),
  });
  const rulesQuery = useQuery({
    queryKey: ['alerts-rules'],
    queryFn: () => apiFetch<AlertRulesResponse>('/api/alerts/rules'),
  });
  const catalogQuery = useQuery({
    queryKey: ['alerts-catalog'],
    queryFn: () => apiFetch<AlertCatalogResponse>('/api/alerts/catalog'),
  });

  const parseMutation = useMutation({
    mutationFn: (description: string) =>
      apiFetch<AlertParseResponse>('/api/alerts/ai/parse', {
        method: 'POST',
        body: JSON.stringify({ description }),
      }),
    onSuccess: (response) => {
      setEditingRuleId(null);
      setBuilder(response.draft);
      setLabelsText(labelsToText(response.draft.spec.labels));
      setTagsText(listToCsv(response.draft.spec.scope.tags));
      setAiNotice(
        response.generatedByAi
          ? `AI drafted a rule${typeof response.confidence === 'number' ? ` (${response.confidence}% confidence)` : ''}.`
          : 'Heuristic draft generated.',
      );
      setAiWarnings(response.warnings ?? []);
      setBuilderError(null);
    },
    onError: (error) => {
      setAiNotice(null);
      setAiWarnings([]);
      setBuilderError(
        error instanceof Error ? error.message : 'Failed to parse alert description.',
      );
    },
  });

  const previewMutation = useMutation({
    mutationFn: (draft: AlertRuleDraft) =>
      apiFetch<AlertPreviewResponse>('/api/alerts/preview', {
        method: 'POST',
        body: JSON.stringify({ rule: draft }),
      }),
    onError: (error) => {
      setBuilderError(error instanceof Error ? error.message : 'Failed to preview alert rule.');
    },
  });

  const createRuleMutation = useMutation({
    mutationFn: (payload: AlertRuleMutationPayload) =>
      apiFetch('/api/alerts/rules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: async () => {
      setEditingRuleId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['alerts-rules'] }),
        queryClient.invalidateQueries({ queryKey: ['alerts-incidents'] }),
      ]);
      setBuilderError(null);
    },
    onError: (error) => {
      setBuilderError(error instanceof Error ? error.message : 'Failed to save alert rule.');
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: AlertRuleMutationPayload }) =>
      apiFetch(`/api/alerts/rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['alerts-rules'] }),
        queryClient.invalidateQueries({ queryKey: ['alerts-incidents'] }),
      ]);
      setBuilderError(null);
    },
    onError: (error) => {
      setBuilderError(error instanceof Error ? error.message : 'Failed to update alert rule.');
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (incidentId: string) =>
      apiFetch(`/api/alerts/incidents/${incidentId}/ack`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['alerts-incidents'] });
    },
  });

  const silenceMutation = useMutation({
    mutationFn: ({ incidentId, reason }: { incidentId: string; reason: string }) =>
      apiFetch('/api/silences', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          targetType: 'ALERT_EVENT',
          targetId: incidentId,
          reason,
          endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['alerts-incidents'] });
    },
  });

  if (incidentsQuery.isLoading || rulesQuery.isLoading || catalogQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (incidentsQuery.isError || rulesQuery.isError || catalogQuery.isError || !catalogQuery.data) {
    return <div className="text-sm text-rose-400">Failed to load alerts workspace.</div>;
  }

  const catalog = catalogQuery.data;
  const comparators = catalog.comparators.length > 0 ? catalog.comparators : fallbackComparators;
  const reducers = catalog.reducers.length > 0 ? catalog.reducers : fallbackReducers;
  /**
   * Implements incidents.
   */
  const incidents = (incidentsQuery.data?.incidents ?? []).filter((incident) => {
    if (statusFilter === 'all') {
      return true;
    }
    if (statusFilter === 'resolved') {
      return incident.state === 'RESOLVED';
    }
    return incident.state !== 'RESOLVED';
  });
  const rules = rulesQuery.data?.rules ?? [];
  const activeSave = createRuleMutation.isPending || updateRuleMutation.isPending;
  const preview = previewMutation.data;
  const selectedScope = builder.spec.scope.entity;
  const selectedEntityId =
    selectedScope === 'host'
      ? (builder.spec.scope.hostIds?.[0] ?? '')
      : selectedScope === 'service'
        ? (builder.spec.scope.serviceIds?.[0] ?? '')
        : selectedScope === 'check'
          ? (builder.spec.scope.checkIds?.[0] ?? '')
          : '';

  /**
   * Implements update builder.
   */
  function updateBuilder(next: AlertRuleDraft) {
    setBuilder(next);
  }

  /**
   * Implements apply rule.
   */
  function applyRule(rule: AlertRuleRecord | AlertRuleDraft) {
    setBuilder({
      name: rule.name,
      description: rule.description ?? '',
      enabled: rule.enabled,
      spec: rule.spec,
    });
    setLabelsText(labelsToText(rule.spec.labels));
    setTagsText(listToCsv(rule.spec.scope.tags));
    setAiNotice(null);
    setAiWarnings([]);
    setBuilderError(null);
    setEditingRuleId('id' in rule ? rule.id : null);
  }

  /**
   * Implements update condition.
   */
  function updateCondition(index: number, condition: AlertCondition) {
    const items = [...builder.spec.conditions.items];
    items[index] = condition;
    updateBuilder({
      ...builder,
      spec: {
        ...builder.spec,
        conditions: {
          ...builder.spec.conditions,
          items,
        },
      },
    });
  }

  /**
   * Implements update condition kind.
   */
  function updateConditionKind(index: number, kind: ConditionKind) {
    updateCondition(index, createDefaultCondition(kind));
  }

  /**
   * Implements add condition.
   */
  function addCondition(kind: ConditionKind) {
    updateBuilder({
      ...builder,
      spec: {
        ...builder.spec,
        conditions: {
          ...builder.spec.conditions,
          items: [...builder.spec.conditions.items, createDefaultCondition(kind)],
        },
      },
    });
  }

  /**
   * Implements remove condition.
   */
  function removeCondition(index: number) {
    if (builder.spec.conditions.items.length === 1) {
      return;
    }

    updateBuilder({
      ...builder,
      spec: {
        ...builder.spec,
        conditions: {
          ...builder.spec.conditions,
          items: builder.spec.conditions.items.filter((_, itemIndex) => itemIndex !== index),
        },
      },
    });
  }

  /**
   * Implements update scope.
   */
  function updateScope(entity: AlertScopeEntity, entityId: string) {
    updateBuilder({
      ...builder,
      spec: {
        ...builder.spec,
        scope: {
          entity,
          hostIds: entity === 'host' && entityId ? [entityId] : [],
          serviceIds: entity === 'service' && entityId ? [entityId] : [],
          checkIds: entity === 'check' && entityId ? [entityId] : [],
          tags: builder.spec.scope.tags ?? [],
        },
      },
    });
  }

  /**
   * Builds payload.
   */
  function buildPayload(enabled: boolean) {
    const payload = toRulePayload(builder, labelsText, tagsText, enabled);
    if (!payload.name) {
      setBuilderError('Rule name is required.');
      return null;
    }
    if (payload.spec.conditions.items.length === 0) {
      setBuilderError('At least one condition is required.');
      return null;
    }
    setBuilderError(null);
    return payload;
  }

  /**
   * Implements save rule.
   */
  function saveRule(enabled: boolean) {
    const payload = buildPayload(enabled);
    if (!payload) {
      return;
    }

    if (editingRuleId) {
      updateRuleMutation.mutate({ id: editingRuleId, payload });
      return;
    }

    createRuleMutation.mutate(payload);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>Incidents</CardTitle>
            <CardDescription>
              Active and recently resolved alerts, with quick acknowledgement and silence controls.
            </CardDescription>
          </div>
          <div className="w-full md:w-48">
            <Select
              aria-label="Incident status filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="open">Open incidents</option>
              <option value="all">All incidents</option>
              <option value="resolved">Resolved only</option>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {incidents.length === 0 ? (
            <div className="text-muted-foreground">No incidents match the current filter.</div>
          ) : null}
          {incidents.map((incident) => (
            <div
              key={incident.id}
              className={`rounded-xl border p-4 ${incidentStateTone(incident.state)}`}
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="border-current/40 bg-transparent text-current">
                      {incidentStateLabel(incident.state)}
                    </Badge>
                    <Badge className="border-current/40 bg-transparent text-current">
                      {incident.severity}
                    </Badge>
                    <span className="text-xs text-current/80">{incident.ruleName}</span>
                  </div>
                  <div className="font-medium">{incident.message}</div>
                  <div className="flex flex-wrap gap-3 text-xs text-current/80">
                    <span>Started {formatTimestamp(incident.startedAt)}</span>
                    <span>Last evaluated {formatTimestamp(incident.lastEvaluatedAt)}</span>
                    {incident.acknowledgedAt ? (
                      <span>Acknowledged {formatTimestamp(incident.acknowledgedAt)}</span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-current/90">
                    {incident.host ? <span>Host: {incident.host.name}</span> : null}
                    {incident.service ? <span>Service: {incident.service.name}</span> : null}
                    {incident.check ? <span>Check: {incident.check.name}</span> : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={Boolean(incident.acknowledgedAt) || acknowledgeMutation.isPending}
                    onClick={() => acknowledgeMutation.mutate(incident.id)}
                  >
                    {incident.acknowledgedAt ? 'Acknowledged' : 'Acknowledge'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={silenceMutation.isPending}
                    onClick={() =>
                      silenceMutation.mutate({
                        incidentId: incident.id,
                        reason: `Muted from alerts page for ${incident.ruleName}`,
                      })
                    }
                  >
                    Silence 1h
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>
            Review stored rules and load any rule into the builder for refinement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {rules.length === 0 ? (
            <div className="text-muted-foreground">No alert rules have been saved yet.</div>
          ) : null}
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium">{rule.name}</div>
                    <Badge
                      className={
                        rule.enabled
                          ? 'border-emerald-500/40 text-emerald-300'
                          : 'border-amber-500/40 text-amber-300'
                      }
                    >
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    <Badge>{rule.spec.severity}</Badge>
                  </div>
                  <div className="text-muted-foreground">
                    {rule.description || 'No description provided.'}
                  </div>
                  <div className="text-xs text-muted-foreground">{describeRule(rule)}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => applyRule(rule)}>
                  Edit in builder
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editingRuleId ? 'Edit Rule' : 'Draft Builder'}</CardTitle>
          <CardDescription>
            Use English drafting, then refine the typed scope, conditions, delivery, and preview
            before saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-4">
            <div className="space-y-1">
              <div className="text-sm font-medium">Describe the alert in English</div>
              <div className="text-xs text-muted-foreground">
                This creates a structured draft. It does not save or enable anything automatically.
              </div>
            </div>
            <Textarea
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder="Alert when any host disk stays above 85% for 30 minutes and repeat hourly."
              rows={3}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={parseMutation.isPending || aiPrompt.trim().length === 0}
                onClick={() => parseMutation.mutate(aiPrompt)}
              >
                {parseMutation.isPending ? 'Drafting...' : 'Draft with AI'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditingRuleId(null);
                  const next = createDefaultRuleDraft();
                  setBuilder(next);
                  setLabelsText(labelsToText(next.spec.labels));
                  setTagsText('');
                  setAiNotice(null);
                  setAiWarnings([]);
                  setBuilderError(null);
                }}
              >
                Reset draft
              </Button>
            </div>
            {aiNotice ? <div className="text-sm text-sky-300">{aiNotice}</div> : null}
            {aiWarnings.length > 0 ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                {aiWarnings.map((warning, index) => (
                  <div key={`${warning}-${index}`}>{warning}</div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Rule name</span>
                  <Input
                    value={builder.name}
                    onChange={(event) => updateBuilder({ ...builder, name: event.target.value })}
                    placeholder="High CPU sustained"
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Severity</span>
                  <Select
                    value={builder.spec.severity}
                    onChange={(event) =>
                      updateBuilder({
                        ...builder,
                        spec: {
                          ...builder.spec,
                          severity: event.target.value as AlertRuleDraft['spec']['severity'],
                        },
                      })
                    }
                  >
                    <option value="INFO">INFO</option>
                    <option value="WARN">WARN</option>
                    <option value="ERROR">ERROR</option>
                  </Select>
                </label>
              </div>

              <label className="space-y-2 text-sm">
                <span className="font-medium">Description</span>
                <Textarea
                  value={builder.description ?? ''}
                  onChange={(event) =>
                    updateBuilder({ ...builder, description: event.target.value })
                  }
                  rows={3}
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Scope</span>
                  <Select
                    value={selectedScope}
                    onChange={(event) => updateScope(event.target.value as AlertScopeEntity, '')}
                  >
                    {scopeEntities.map((entity) => (
                      <option key={entity} value={entity}>
                        {entity}
                      </option>
                    ))}
                  </Select>
                </label>
                {selectedScope !== 'homelab' ? (
                  <label className="space-y-2 text-sm">
                    <span className="font-medium">Entity filter</span>
                    <Select
                      value={selectedEntityId}
                      onChange={(event) => updateScope(selectedScope, event.target.value)}
                    >
                      <option value="">All {selectedScope}s</option>
                      {selectedScope === 'host'
                        ? catalog.hosts.map((host) => (
                            <option key={host.id} value={host.id}>
                              {host.hostname}
                            </option>
                          ))
                        : null}
                      {selectedScope === 'service'
                        ? catalog.services.map((service) => (
                            <option key={service.id} value={service.id}>
                              {service.name}
                            </option>
                          ))
                        : null}
                      {selectedScope === 'check'
                        ? catalog.checks.map((check) => (
                            <option key={check.id} value={check.id}>
                              {check.name}
                            </option>
                          ))
                        : null}
                    </Select>
                  </label>
                ) : null}
              </div>

              {selectedScope === 'host' ? (
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Host tags</span>
                  <Input
                    value={tagsText}
                    onChange={(event) => setTagsText(event.target.value)}
                    placeholder="gpu, storage"
                  />
                </label>
              ) : null}

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">Conditions</div>
                    <div className="text-xs text-muted-foreground">
                      Flat ALL/ANY matching across typed alert conditions.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={builder.spec.conditions.match}
                      onChange={(event) =>
                        updateBuilder({
                          ...builder,
                          spec: {
                            ...builder.spec,
                            conditions: {
                              ...builder.spec.conditions,
                              match: event.target.value as AlertConditionMatch,
                            },
                          },
                        })
                      }
                    >
                      {matchModes.map((mode) => (
                        <option key={mode} value={mode}>
                          Match {mode}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label="Condition type to add"
                      value={conditionToAdd}
                      onChange={(event) => setConditionToAdd(event.target.value as ConditionKind)}
                    >
                      {conditionKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addCondition(conditionToAdd)}
                    >
                      Add condition
                    </Button>
                  </div>
                </div>

                {builder.spec.conditions.items.map((condition, index) => (
                  <div
                    key={`condition-${index}`}
                    className="space-y-3 rounded-xl border border-border/70 bg-background/60 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Select
                        value={getConditionKind(condition)}
                        onChange={(event) =>
                          updateConditionKind(index, event.target.value as ConditionKind)
                        }
                      >
                        {conditionKinds.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind}
                          </option>
                        ))}
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={builder.spec.conditions.items.length === 1}
                        onClick={() => removeCondition(index)}
                      >
                        Remove
                      </Button>
                    </div>

                    {condition.kind === 'host_metric' ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          <span>Metric</span>
                          <Select
                            value={condition.metric}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                metric: event.target.value as AlertHostMetricCondition['metric'],
                              })
                            }
                          >
                            {catalog.hostMetrics.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Reducer</span>
                          <Select
                            value={condition.reducer}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                reducer: event.target.value as AlertReducer,
                              })
                            }
                          >
                            {reducers.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Comparator</span>
                          <Select
                            value={condition.comparator}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                comparator: event.target.value as AlertComparator,
                              })
                            }
                          >
                            {comparators.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Threshold</span>
                          <Input
                            type="number"
                            value={condition.threshold}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                threshold: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                        <label className="space-y-2 text-sm md:col-span-2">
                          <span>Window minutes</span>
                          <Input
                            type="number"
                            value={condition.windowMinutes}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                windowMinutes: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                      </div>
                    ) : null}

                    {condition.kind === 'homelab_metric' ? (
                      <div className="grid gap-3 md:grid-cols-3">
                        <label className="space-y-2 text-sm">
                          <span>Metric</span>
                          <Select
                            value={condition.metric}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                metric: event.target.value as AlertHomelabMetricCondition['metric'],
                              })
                            }
                          >
                            {catalog.homelabMetrics.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Comparator</span>
                          <Select
                            value={condition.comparator}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                comparator: event.target.value as AlertComparator,
                              })
                            }
                          >
                            {comparators.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Threshold</span>
                          <Input
                            type="number"
                            value={condition.threshold}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                threshold: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                      </div>
                    ) : null}

                    {condition.kind === 'check' ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          <span>Mode</span>
                          <Select
                            value={condition.mode}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                mode: event.target.value as AlertCheckMode,
                              })
                            }
                          >
                            {catalog.checkModes.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Threshold</span>
                          <Input
                            type="number"
                            value={condition.threshold}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                threshold: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Sample size</span>
                          <Input
                            type="number"
                            value={condition.sampleSize ?? ''}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                sampleSize: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Window minutes</span>
                          <Input
                            type="number"
                            value={condition.windowMinutes ?? ''}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                windowMinutes: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                        {condition.mode === 'http_status_not' ? (
                          <label className="space-y-2 text-sm md:col-span-2">
                            <span>Expected HTTP status</span>
                            <Input
                              type="number"
                              value={condition.expectedStatus ?? ''}
                              onChange={(event) =>
                                updateCondition(index, {
                                  ...condition,
                                  expectedStatus: Number(event.target.value || 0),
                                })
                              }
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}

                    {condition.kind === 'state' ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          <span>State target</span>
                          <Select
                            value={condition.target}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                target: event.target.value as AlertStateCondition['target'],
                              })
                            }
                          >
                            {catalog.stateTargets.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Stale minutes</span>
                          <Input
                            type="number"
                            value={condition.staleMinutes ?? ''}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                staleMinutes: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                      </div>
                    ) : null}

                    {condition.kind === 'event_count' ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="space-y-2 text-sm">
                          <span>Comparator</span>
                          <Select
                            value={condition.comparator}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                comparator: event.target.value as AlertComparator,
                              })
                            }
                          >
                            {comparators.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Threshold</span>
                          <Input
                            type="number"
                            value={condition.threshold}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                threshold: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Window minutes</span>
                          <Input
                            type="number"
                            value={condition.windowMinutes}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                windowMinutes: Number(event.target.value || 0),
                              })
                            }
                          />
                        </label>
                        <label className="space-y-2 text-sm">
                          <span>Severity filter</span>
                          <Select
                            value={condition.severity ?? ''}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                severity: event.target
                                  .value as AlertEventCountCondition['severity'],
                              })
                            }
                          >
                            <option value="">Any severity</option>
                            <option value="INFO">INFO</option>
                            <option value="WARN">WARN</option>
                            <option value="ERROR">ERROR</option>
                          </Select>
                        </label>
                        <label className="space-y-2 text-sm md:col-span-2">
                          <span>Event type contains</span>
                          <Input
                            value={condition.eventType ?? ''}
                            onChange={(event) =>
                              updateCondition(index, {
                                ...condition,
                                eventType: event.target.value,
                              })
                            }
                            placeholder="check.down"
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Pending minutes</span>
                  <Input
                    type="number"
                    value={builder.spec.evaluation.pendingMinutes}
                    onChange={(event) =>
                      updateBuilder({
                        ...builder,
                        spec: {
                          ...builder.spec,
                          evaluation: {
                            ...builder.spec.evaluation,
                            pendingMinutes: Number(event.target.value || 0),
                          },
                        },
                      })
                    }
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Recovery minutes</span>
                  <Input
                    type="number"
                    value={builder.spec.evaluation.recoveryMinutes}
                    onChange={(event) =>
                      updateBuilder({
                        ...builder,
                        spec: {
                          ...builder.spec,
                          evaluation: {
                            ...builder.spec.evaluation,
                            recoveryMinutes: Number(event.target.value || 0),
                          },
                        },
                      })
                    }
                  />
                </label>
              </div>

              <label className="space-y-2 text-sm">
                <span className="font-medium">No-data behavior</span>
                <Select
                  value={builder.spec.evaluation.noDataBehavior}
                  onChange={(event) =>
                    updateBuilder({
                      ...builder,
                      spec: {
                        ...builder.spec,
                        evaluation: {
                          ...builder.spec.evaluation,
                          noDataBehavior: event.target
                            .value as AlertRuleDraft['spec']['evaluation']['noDataBehavior'],
                        },
                      },
                    })
                  }
                >
                  <option value="KEEP_STATE">Keep current state</option>
                  <option value="RESOLVE">Resolve when data disappears</option>
                  <option value="ALERT">Fire on missing data</option>
                </Select>
              </label>

              <div className="space-y-3">
                <div className="text-sm font-medium">Notification routes</div>
                <div className="grid gap-2">
                  {catalog.notificationRoutes.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                      No notification routes available.
                    </div>
                  ) : (
                    catalog.notificationRoutes.map((route) => {
                      const checked = builder.spec.delivery.routeIds.includes(route.id);
                      return (
                        <label
                          key={route.id}
                          className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const routeIds = event.target.checked
                                ? [...builder.spec.delivery.routeIds, route.id]
                                : builder.spec.delivery.routeIds.filter(
                                    (routeId) => routeId !== route.id,
                                  );
                              updateBuilder({
                                ...builder,
                                spec: {
                                  ...builder.spec,
                                  delivery: {
                                    ...builder.spec.delivery,
                                    routeIds,
                                  },
                                },
                              });
                            }}
                          />
                          <span>{route.name ?? route.id}</span>
                          <span className="text-xs text-muted-foreground">
                            {route.type ?? 'route'}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Repeat minutes</span>
                  <Input
                    type="number"
                    value={builder.spec.delivery.repeatMinutes}
                    onChange={(event) =>
                      updateBuilder({
                        ...builder,
                        spec: {
                          ...builder.spec,
                          delivery: {
                            ...builder.spec.delivery,
                            repeatMinutes: Number(event.target.value || 0),
                          },
                        },
                      })
                    }
                  />
                </label>
                <label className="flex items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    checked={builder.spec.delivery.sendResolved}
                    onChange={(event) =>
                      updateBuilder({
                        ...builder,
                        spec: {
                          ...builder.spec,
                          delivery: {
                            ...builder.spec.delivery,
                            sendResolved: event.target.checked,
                          },
                        },
                      })
                    }
                  />
                  <span>Send resolved notifications</span>
                </label>
              </div>

              <label className="space-y-2 text-sm">
                <span className="font-medium">Labels</span>
                <Textarea
                  value={labelsText}
                  onChange={(event) => setLabelsText(event.target.value)}
                  rows={4}
                  placeholder={'team=ops\nservice=database'}
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={previewMutation.isPending}
                  onClick={() => {
                    const draft = normalizeRuleDraft(builder, labelsText, tagsText);
                    if (!draft.name) {
                      setBuilderError('Rule name is required.');
                      return;
                    }
                    if (draft.spec.conditions.items.length === 0) {
                      setBuilderError('At least one condition is required.');
                      return;
                    }
                    setBuilderError(null);
                    previewMutation.mutate(draft);
                  }}
                >
                  {previewMutation.isPending ? 'Previewing...' : 'Preview rule'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={activeSave}
                  onClick={() => saveRule(false)}
                >
                  {activeSave && !editingRuleId
                    ? 'Saving...'
                    : editingRuleId
                      ? 'Save disabled'
                      : 'Save disabled'}
                </Button>
                <Button type="button" disabled={activeSave} onClick={() => saveRule(true)}>
                  {activeSave
                    ? 'Saving...'
                    : editingRuleId
                      ? 'Save and enable'
                      : 'Create and enable'}
                </Button>
              </div>
              {builderError ? <div className="text-sm text-rose-400">{builderError}</div> : null}
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm font-medium">Preview</div>
                <div className="text-xs text-muted-foreground">
                  Check current matches before you save or enable the rule.
                </div>
              </div>
              {preview ? (
                <div className="text-xs text-muted-foreground">
                  Evaluated {formatTimestamp(preview.evaluatedAt)}
                </div>
              ) : null}
            </div>
            {!preview ? (
              <div className="text-sm text-muted-foreground">
                Run a preview to see candidate matches and incident states.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-lg border border-border/70 bg-background/60 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Candidates
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {preview.summary.candidateCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/60 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Matched
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {preview.summary.matchedCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/60 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Pending
                    </div>
                    <div className="mt-1 text-2xl font-semibold">
                      {preview.summary.pendingCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-background/60 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Firing
                    </div>
                    <div className="mt-1 text-2xl font-semibold">{preview.summary.firingCount}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {preview.incidents.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      No current matches for this draft.
                    </div>
                  ) : null}
                  {preview.incidents.map((incident) => (
                    <div
                      key={incident.fingerprint}
                      className="rounded-lg border border-border/70 bg-background/60 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{incident.state}</Badge>
                        <Badge>{incident.severity}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {previewEntityName(incident)}
                        </span>
                      </div>
                      <div className="mt-2 text-sm font-medium">{incident.message}</div>
                      {formatPreviewValues(incident.values) ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatPreviewValues(incident.values)}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

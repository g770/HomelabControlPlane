/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the host detail page route view.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { HostMetadataEditor } from '@/components/host-metadata-editor';
import { HealthBadge } from '@/components/health-badge';
import { HostSshPanel } from '@/components/host-ssh-panel';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import {
  readServiceInstanceState,
  runtimeStateBadgeStatus,
  serviceInstanceStateLabel,
} from '@/lib/service-state';
import { formatTimeAgo, formatTimestamp } from '@/lib/time';
import type { LinkWidgetMetricId, LinksDashboardResponse } from '@/types/api';
import {
  BulletSection,
  DualTrendCard,
  EventSeverityIcon,
  MetricTrendCard,
  Section,
  SummaryPlaceholder,
} from './host-detail/components';
import type {
  HostDetailSummary,
  HostEvent,
  HostFact,
  HostServiceInstance,
  HostTelemetryConfigResponse,
  HostTelemetryRefreshResponse,
} from './host-detail/types';
import {
  buildDiskIoSeries,
  buildMetricSeries,
  buildNetworkThroughputSeries,
  cloneDashboard,
  createLocalId,
  eventToneClass,
  filterHostServiceInstances,
  formatBytesPerSecond,
  hostServiceHealthStatuses,
  listServiceRuntimeStates,
  metricLabel,
  normalizeSeverity,
  normalizeServiceHealthStatus,
  normalizeServiceRuntimeState,
  parseIntervalInput,
  readHostIp,
  readString,
  type HostServiceHealthStatus,
  toRecord,
  toSafeNumber,
} from './host-detail/utils';

/**
 * Renders the host detail page view.
 */
export function HostDetailPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const hostId = params.id;
  const [addWidgetNotice, setAddWidgetNotice] = useState<string | null>(null);
  const [telemetryNotice, setTelemetryNotice] = useState<string | null>(null);
  const [telemetryDraft, setTelemetryDraft] = useState({
    heartbeatSec: '',
    factsSec: '',
    inventorySec: '',
  });
  const [serviceSearchQuery, setServiceSearchQuery] = useState('');
  const [selectedServiceHealth, setSelectedServiceHealth] = useState<HostServiceHealthStatus[]>([]);
  const [selectedRuntimeStates, setSelectedRuntimeStates] = useState<string[]>([]);

  const query = useQuery({
    queryKey: ['host', hostId],
    enabled: Boolean(hostId),
    queryFn: () => apiFetch<Record<string, unknown>>(`/api/hosts/${hostId}`),
    // Event stream invalidation is primary, but this keeps charts fresh if SSE
    // is interrupted or unavailable in the browser/network path.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const summaryQuery = useQuery({
    queryKey: ['host-summary', hostId],
    enabled: Boolean(hostId),
    queryFn: () => apiFetch<HostDetailSummary>(`/api/ai/hosts/${hostId}/summary`),
  });

  const telemetryQuery = useQuery({
    queryKey: ['host-telemetry-config', hostId],
    enabled: Boolean(hostId),
    queryFn: () => apiFetch<HostTelemetryConfigResponse>(`/api/hosts/${hostId}/telemetry/config`),
  });

  useEffect(() => {
    if (!telemetryQuery.data) {
      return;
    }
    setTelemetryDraft({
      heartbeatSec: String(telemetryQuery.data.config.heartbeatSec),
      factsSec: String(telemetryQuery.data.config.factsSec),
      inventorySec: String(telemetryQuery.data.config.inventorySec),
    });
  }, [telemetryQuery.data]);

  const telemetryUpdateMutation = useMutation({
    mutationFn: async () => {
      if (!hostId) {
        throw new Error('Host id is missing.');
      }
      const heartbeatSec = parseIntervalInput(telemetryDraft.heartbeatSec, 'heartbeat');
      const factsSec = parseIntervalInput(telemetryDraft.factsSec, 'facts');
      const inventorySec = parseIntervalInput(telemetryDraft.inventorySec, 'inventory');

      return apiFetch<HostTelemetryConfigResponse>(`/api/hosts/${hostId}/telemetry/config`, {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          heartbeatSec,
          factsSec,
          inventorySec,
        }),
      });
    },
    onSuccess: async (response) => {
      setTelemetryNotice(
        `Telemetry updated: heartbeat ${response.config.heartbeatSec}s, facts ${response.config.factsSec}s, inventory ${response.config.inventorySec}s.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['host-telemetry-config', hostId] });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Failed to update telemetry settings.';
      setTelemetryNotice(message);
    },
  });

  const telemetryRefreshMutation = useMutation({
    mutationFn: async () => {
      if (!hostId) {
        throw new Error('Host id is missing.');
      }
      return apiFetch<HostTelemetryRefreshResponse>(`/api/hosts/${hostId}/telemetry/refresh`, {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          reason: 'host_detail_manual_refresh',
        }),
      });
    },
    onSuccess: async (response) => {
      setTelemetryNotice(
        response.queued
          ? 'Telemetry refresh request queued. Updated samples should appear shortly.'
          : 'Telemetry refresh request could not be queued because one is already pending.',
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['host', hostId] }),
        queryClient.invalidateQueries({ queryKey: ['host-summary', hostId] }),
        queryClient.invalidateQueries({ queryKey: ['host-telemetry-config', hostId] }),
      ]);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Failed to request telemetry refresh.';
      setTelemetryNotice(message);
    },
  });

  const addWidgetMutation = useMutation({
    mutationFn: async (metric: LinkWidgetMetricId) => {
      if (!hostId) {
        throw new Error('Host id is missing.');
      }

      const dashboardResponse = await apiFetch<LinksDashboardResponse>('/api/links/dashboard');
      const dashboard = cloneDashboard(dashboardResponse.dashboard);
      // Default insertion point is first group so "Add to Dashboard" is one-click.
      const targetGroup = dashboard.groups[0];
      if (!targetGroup) {
        throw new Error('No links group is available.');
      }

      const hostName = String(query.data?.hostname ?? 'Host');
      const exists = dashboard.groups.some((group) =>
        (group.widgets ?? []).some(
          (widget) =>
            widget.kind === 'host-metric' && widget.hostId === hostId && widget.metric === metric,
        ),
      );
      if (exists) {
        return { metric, status: 'exists' as const };
      }

      targetGroup.widgets = [
        ...(targetGroup.widgets ?? []),
        {
          id: createLocalId(),
          kind: 'host-metric',
          title: `${hostName} ${metricLabel(metric)}`,
          description: `Live ${metricLabel(metric)} trend from host detail.`,
          hostId,
          hostName,
          metric,
          size: 'wide',
        },
      ];

      await apiFetch('/api/links/dashboard', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          dashboard,
        }),
      });

      return { metric, status: 'added' as const };
    },
    onSuccess: (result) => {
      if (result.status === 'exists') {
        setAddWidgetNotice(`${metricLabel(result.metric)} widget is already on your Dashboard.`);
        return;
      }
      setAddWidgetNotice(`${metricLabel(result.metric)} widget added to your Dashboard.`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to add widget.';
      setAddWidgetNotice(message);
    },
  });

  if (query.isLoading) {
    return <PageSkeleton />;
  }

  if (query.isError || !query.data) {
    return <div className="text-sm text-rose-400">Failed to load host detail.</div>;
  }

  const host = query.data;
  const hostRecord = toRecord(host);
  const hostTags = Array.isArray(host.tags) ? host.tags.map((tag) => String(tag)) : [];
  const hostTypeRaw = String(hostRecord?.hostType ?? 'MACHINE')
    .trim()
    .toUpperCase();
  const hostType = hostTypeRaw === 'CONTAINER' ? 'CONTAINER' : 'MACHINE';
  const facts = (Array.isArray(host.facts) ? host.facts : []) as HostFact[];
  const latestFact = facts.length > 0 ? facts[0] : null;
  const latestSnapshot = toRecord(latestFact?.snapshot);
  const hostIp = readString(hostRecord, ['hostIp']) ?? readHostIp(latestSnapshot);
  const cpuSeries = buildMetricSeries(facts, 'cpu');
  const memSeries = buildMetricSeries(facts, 'mem');
  const diskSeries = buildMetricSeries(facts, 'disk');
  const networkSeries = buildNetworkThroughputSeries(facts);
  const diskIoSeries = buildDiskIoSeries(facts);
  const historyCount = Math.max(
    cpuSeries.length,
    memSeries.length,
    diskSeries.length,
    networkSeries.length,
    diskIoSeries.length,
  );
  const serviceInstances: HostServiceInstance[] = Array.isArray(host.serviceInstances)
    ? (host.serviceInstances as HostServiceInstance[])
    : [];
  const availableRuntimeStates = listServiceRuntimeStates(serviceInstances);
  const filteredServiceInstances = filterHostServiceInstances(serviceInstances, {
    query: serviceSearchQuery,
    selectedHealth: new Set(selectedServiceHealth),
    selectedRuntimeStates: new Set(selectedRuntimeStates),
  });
  const hostEvents: HostEvent[] = Array.isArray(host.events) ? (host.events as HostEvent[]) : [];
  const telemetryConfig = telemetryQuery.data?.config;
  const telemetryIsUnavailable = telemetryQuery.isError;
  const telemetryHasConfig = Boolean(telemetryConfig);
  const telemetryDraftValues = telemetryHasConfig
    ? {
        heartbeatSec: toSafeNumber(telemetryDraft.heartbeatSec, telemetryConfig?.heartbeatSec ?? 0),
        factsSec: toSafeNumber(telemetryDraft.factsSec, telemetryConfig?.factsSec ?? 0),
        inventorySec: toSafeNumber(telemetryDraft.inventorySec, telemetryConfig?.inventorySec ?? 0),
      }
    : null;
  const telemetryDirty =
    telemetryHasConfig &&
    telemetryDraftValues !== null &&
    (telemetryDraftValues.heartbeatSec !== telemetryConfig?.heartbeatSec ||
      telemetryDraftValues.factsSec !== telemetryConfig?.factsSec ||
      telemetryDraftValues.inventorySec !== telemetryConfig?.inventorySec);
  const telemetryRange = telemetryHasConfig
    ? `${telemetryConfig?.minSec ?? 5}-${telemetryConfig?.maxSec ?? 3600}`
    : '5-3600';

  /**
   * Implements toggle health filter.
   */
  const toggleHealthFilter = (status: HostServiceHealthStatus) => {
    setSelectedServiceHealth((current) =>
      current.includes(status) ? current.filter((value) => value !== status) : [...current, status],
    );
  };

  /**
   * Implements toggle runtime state filter.
   */
  const toggleRuntimeStateFilter = (state: string) => {
    setSelectedRuntimeStates((current) =>
      current.includes(state) ? current.filter((value) => value !== state) : [...current, state],
    );
  };

  /**
   * Implements clear service filters.
   */
  const clearServiceFilters = () => {
    setServiceSearchQuery('');
    setSelectedServiceHealth([]);
    setSelectedRuntimeStates([]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-1">
        <h1 className="text-2xl font-semibold">{String(host.hostname ?? 'host')}</h1>
        <HealthBadge status={String(host.status ?? 'UNKNOWN')} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Metric Trends</CardTitle>
          <p className="text-xs text-muted-foreground">
            Historical usage and throughput from recent fact snapshots ({historyCount} sample
            {historyCount === 1 ? '' : 's'}).
          </p>
          {addWidgetNotice && <p className="text-xs text-muted-foreground">{addWidgetNotice}</p>}
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <MetricTrendCard
            title="CPU Usage"
            points={cpuSeries}
            toneClass="text-red-500"
            onAddToLinks={() => addWidgetMutation.mutate('cpu')}
            addDisabled={addWidgetMutation.isPending}
          />
          <MetricTrendCard
            title="Memory Usage"
            points={memSeries}
            toneClass="text-amber-500"
            onAddToLinks={() => addWidgetMutation.mutate('mem')}
            addDisabled={addWidgetMutation.isPending}
          />
          <MetricTrendCard
            title="Disk Usage"
            points={diskSeries}
            toneClass="text-emerald-500"
            onAddToLinks={() => addWidgetMutation.mutate('disk')}
            addDisabled={addWidgetMutation.isPending}
          />
          <DualTrendCard
            title="Network Throughput"
            points={networkSeries}
            primaryLabel="Rx"
            secondaryLabel="Tx"
            primaryToneClass="text-cyan-400"
            secondaryToneClass="text-indigo-400"
            formatter={formatBytesPerSecond}
            emptyText="No network throughput samples available yet."
            onAddToLinks={() => addWidgetMutation.mutate('network')}
            addDisabled={addWidgetMutation.isPending}
          />
          <DualTrendCard
            title="Disk I/O Throughput"
            points={diskIoSeries}
            primaryLabel="Read"
            secondaryLabel="Write"
            primaryToneClass="text-emerald-400"
            secondaryToneClass="text-amber-400"
            formatter={formatBytesPerSecond}
            emptyText="No disk I/O counters reported yet."
            onAddToLinks={() => addWidgetMutation.mutate('diskIo')}
            addDisabled={addWidgetMutation.isPending}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Telemetry Collection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Configure collection intervals in seconds (allowed range: {telemetryRange}).
            </p>
            {telemetryQuery.isLoading && (
              <SummaryPlaceholder text="Loading telemetry settings..." />
            )}
            {telemetryIsUnavailable && (
              <SummaryPlaceholder text="Telemetry settings are unavailable. Ensure this host has an active enrolled agent." />
            )}
            {telemetryHasConfig && (
              <>
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">Heartbeat (sec)</span>
                    <Input
                      value={telemetryDraft.heartbeatSec}
                      inputMode="numeric"
                      onChange={(event) =>
                        setTelemetryDraft((current) => ({
                          ...current,
                          heartbeatSec: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">Facts (sec)</span>
                    <Input
                      value={telemetryDraft.factsSec}
                      inputMode="numeric"
                      onChange={(event) =>
                        setTelemetryDraft((current) => ({
                          ...current,
                          factsSec: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">Inventory (sec)</span>
                    <Input
                      value={telemetryDraft.inventorySec}
                      inputMode="numeric"
                      onChange={(event) =>
                        setTelemetryDraft((current) => ({
                          ...current,
                          inventorySec: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => telemetryUpdateMutation.mutate()}
                    disabled={
                      !telemetryDirty ||
                      telemetryUpdateMutation.isPending ||
                      telemetryRefreshMutation.isPending
                    }
                  >
                    {telemetryUpdateMutation.isPending ? 'Saving...' : 'Save intervals'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => telemetryRefreshMutation.mutate()}
                    disabled={
                      telemetryUpdateMutation.isPending || telemetryRefreshMutation.isPending
                    }
                  >
                    {telemetryRefreshMutation.isPending ? 'Refreshing...' : 'Refresh data now'}
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground">
                  Last agent config update: {formatTimestamp(telemetryConfig?.updatedAt)}
                </div>
              </>
            )}
            {telemetryNotice && (
              <div className="text-xs text-muted-foreground">{telemetryNotice}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Services on This Host</CardTitle>
              <div className="text-xs text-muted-foreground">
                {filteredServiceInstances.length} of {serviceInstances.length} shown
              </div>
            </div>
            {serviceInstances.length > 0 && (
              <div className="space-y-2">
                <Input
                  value={serviceSearchQuery}
                  onChange={(event) => setServiceSearchQuery(event.target.value)}
                  placeholder="Search service name, instance, endpoint, status, or runtime state"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {hostServiceHealthStatuses.map((status) => (
                    <Button
                      key={status}
                      type="button"
                      size="sm"
                      variant={selectedServiceHealth.includes(status) ? 'secondary' : 'outline'}
                      onClick={() => toggleHealthFilter(status)}
                    >
                      {status}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {availableRuntimeStates.map((state) => (
                    <Button
                      key={state}
                      type="button"
                      size="sm"
                      variant={selectedRuntimeStates.includes(state) ? 'secondary' : 'outline'}
                      onClick={() => toggleRuntimeStateFilter(state)}
                    >
                      {state === 'n/a' ? 'N/A' : state.toUpperCase()}
                    </Button>
                  ))}
                </div>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={
                      serviceSearchQuery.trim().length === 0 &&
                      selectedServiceHealth.length === 0 &&
                      selectedRuntimeStates.length === 0
                    }
                    onClick={clearServiceFilters}
                  >
                    Clear filters
                  </Button>
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent className="max-h-80 space-y-2 overflow-y-auto pr-1 text-sm">
            {serviceInstances.length === 0 && (
              <div className="rounded border border-dashed border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
                No service instances are currently discovered for this host.
              </div>
            )}
            {serviceInstances.length > 0 && filteredServiceInstances.length === 0 && (
              <div className="rounded border border-dashed border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
                No service instances match the current filters.
              </div>
            )}
            {filteredServiceInstances.map((instance, index) => {
              const status = String(instance?.status ?? 'UNKNOWN');
              const runtimeState = normalizeServiceRuntimeState(readServiceInstanceState(instance));
              const runtimeStateLabel = serviceInstanceStateLabel(instance);
              const endpoint = instance?.endpoint ? String(instance.endpoint) : null;
              const instanceName = String(instance?.name ?? `service-${index + 1}`);
              const serviceName = String(instance?.service?.name ?? instanceName);
              const lastSeen = instance?.lastSeenAt ? String(instance.lastSeenAt) : undefined;
              const badgeStatus =
                runtimeState === 'n/a'
                  ? normalizeServiceHealthStatus(status)
                  : runtimeStateBadgeStatus(runtimeState);
              const badgeLabel = runtimeState === 'n/a' ? status : runtimeState.toUpperCase();
              return (
                <div
                  key={String(instance?.id ?? `${instanceName}-${index}`)}
                  className="rounded-md border border-border/60 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{serviceName}</div>
                    <HealthBadge status={badgeStatus} label={badgeLabel} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{instanceName}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    State: {runtimeStateLabel}
                  </div>
                  {endpoint && (
                    <div className="mt-1 break-all text-xs text-muted-foreground">{endpoint}</div>
                  )}
                  <div
                    className="mt-1 text-xs text-muted-foreground"
                    title={formatTimestamp(lastSeen)}
                  >
                    Last seen {formatTimeAgo(lastSeen)}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Facts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {summaryQuery.isLoading && <SummaryPlaceholder text="Generating readable summary..." />}
            {!summaryQuery.isLoading && summaryQuery.isError && (
              <SummaryPlaceholder text="Summary unavailable. Showing raw snapshot below." />
            )}
            {!summaryQuery.isLoading && summaryQuery.data && (
              <>
                <div className="text-xs text-muted-foreground">
                  {summaryQuery.data.generatedByAi ? 'AI-generated summary' : 'Rule-based summary'}
                </div>
                <BulletSection title="Overview" bullets={summaryQuery.data.overview} />
                <BulletSection
                  title={summaryQuery.data.sections.facts.title}
                  bullets={summaryQuery.data.sections.facts.bullets}
                />
              </>
            )}
            <details className="rounded border border-border/60 bg-background/50 p-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Raw snapshot JSON
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border/60 bg-background/70 p-3 text-xs">
                {JSON.stringify(latestFact?.snapshot ?? {}, null, 2)}
              </pre>
            </details>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Inventory</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {summaryQuery.isLoading && <SummaryPlaceholder text="Analyzing inventory data..." />}
            {!summaryQuery.isLoading && summaryQuery.isError && (
              <SummaryPlaceholder text="Inventory summary unavailable. Expand raw inventory below." />
            )}
            {!summaryQuery.isLoading && summaryQuery.data && (
              <>
                <BulletSection
                  title={summaryQuery.data.sections.containers.title}
                  bullets={summaryQuery.data.sections.containers.bullets}
                />
                <BulletSection
                  title={summaryQuery.data.sections.systemServices.title}
                  bullets={summaryQuery.data.sections.systemServices.bullets}
                />
                <BulletSection
                  title={summaryQuery.data.sections.storage.title}
                  bullets={summaryQuery.data.sections.storage.bullets}
                />
                <BulletSection
                  title={summaryQuery.data.sections.network.title}
                  bullets={summaryQuery.data.sections.network.bullets}
                />
              </>
            )}
            <details className="rounded border border-border/60 bg-background/50 p-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Raw inventory JSON
              </summary>
              <div className="mt-2 space-y-3">
                <Section title="Containers" data={latestSnapshot?.containers} />
                <Section title="System Services" data={latestSnapshot?.systemd} />
                <Section title="Storage" data={latestSnapshot?.storage} />
                <Section title="Network" data={latestSnapshot?.network} />
              </div>
            </details>
          </CardContent>
        </Card>
      </div>

      <HostSshPanel
        hostId={String(host.id ?? hostId ?? '')}
        hostName={String(host.hostname ?? 'host')}
        hostIp={hostIp}
      />

      <Card>
        <CardHeader>
          <CardTitle>Recent Events</CardTitle>
        </CardHeader>
        <CardContent className="max-h-80 space-y-2 overflow-y-auto pr-1 text-sm">
          {hostEvents.slice(0, 10).map((event) => {
            const severity = normalizeSeverity(String(event?.severity ?? 'INFO'));
            const createdAt = event?.createdAt ? String(event.createdAt) : undefined;
            return (
              <div key={event.id} className="rounded-md border border-border/60 p-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={eventToneClass(severity)} aria-hidden="true">
                      <EventSeverityIcon severity={severity} />
                    </span>
                    <div className="font-medium">{event.type}</div>
                  </div>
                  <div className="text-xs text-muted-foreground" title={formatTimestamp(createdAt)}>
                    {formatTimeAgo(createdAt)}
                  </div>
                </div>
                <div className="text-muted-foreground">{event.message}</div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Host Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <HostMetadataEditor
            hostId={String(host.id ?? hostId ?? '')}
            hostName={String(host.hostname ?? 'host')}
            initialTags={hostTags}
            initialHostType={hostType}
          />
        </CardContent>
      </Card>
    </div>
  );
}

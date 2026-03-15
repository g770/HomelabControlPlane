/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the service discovery page route view.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import { parseDiscoverySubnetInput } from '@/lib/discovery-subnets';
import {
  buildServiceDiscoveryFindings,
  readDiscoveryConsoleSnapshot,
} from '@/lib/service-discovery';
import type {
  ServiceDiscoveryConfig,
  ServiceDiscoveryConfigResponse,
  ServiceDiscoveryConfigUpdatePayload,
  ServiceDiscoveryCatalogResponse,
  ServiceDiscoveryRunDelete,
  ServiceDiscoveryRunDeleteResponse,
  ServiceDiscoveryRunHistoryItem,
  ServiceDiscoveryRunHistoryResponse,
  ServiceDiscoveryRunRequestPayload,
  ServiceDiscoveryRunResponse,
} from '@/types/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const defaultDiscoverySubnetSeeds = ['10.0.0.0/24', '172.16.0.0/24', '192.168.1.0/24'] as const;

type DiscoveryAgent = {
  id: string;
  status: string;
  hostId: string | null;
  revokedAt: string | null;
};

const emptyFindingsSnapshot = {
  rows: [],
  warnings: [],
  nonPersistedMessages: [],
  isEmpty: true,
};

const emptyConsoleSnapshot = {
  entries: [],
  truncated: false,
  progress: null,
};

/**
 * Renders the service discovery page view.
 */
export function ServiceDiscoveryPage() {
  const queryClient = useQueryClient();

  const [isDiscoveryConfigEditing, setIsDiscoveryConfigEditing] = useState(false);
  const [showDetailedDiscoverySubnetValidation, setShowDetailedDiscoverySubnetValidation] =
    useState(false);
  const [discoverySubnetText, setDiscoverySubnetText] = useState(
    defaultDiscoverySubnetSeeds.join('\n'),
  );
  const [discoveryConfigDirty, setDiscoveryConfigDirty] = useState(false);
  const [discoveryIncludeAutoLocalCidrs, setDiscoveryIncludeAutoLocalCidrs] = useState(false);
  const [discoveryIncludeCommonWebPorts, setDiscoveryIncludeCommonWebPorts] = useState(true);
  const [discoveryMaxHosts, setDiscoveryMaxHosts] = useState('512');
  const [discoveryConcurrency, setDiscoveryConcurrency] = useState('24');
  const [discoveryConnectTimeoutMs, setDiscoveryConnectTimeoutMs] = useState('750');
  const [discoveryToolCallTimeoutMs, setDiscoveryToolCallTimeoutMs] = useState('120000');
  const [discoveryEnableSubnetScan, setDiscoveryEnableSubnetScan] = useState(true);
  const [discoveryStatus, setDiscoveryStatus] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  /**
   * Implements apply discovery config.
   */
  const applyDiscoveryConfig = (config: ServiceDiscoveryConfig) => {
    setDiscoveryEnableSubnetScan(config.enabled);
    setDiscoverySubnetText(config.cidrs.join('\n'));
    setDiscoveryIncludeAutoLocalCidrs(config.includeAutoLocalCidrs);
    setDiscoveryIncludeCommonWebPorts(config.includeCommonWebPorts);
    setDiscoveryMaxHosts(String(config.maxHosts));
    setDiscoveryConcurrency(String(config.concurrency));
    setDiscoveryConnectTimeoutMs(String(config.connectTimeoutMs));
    setDiscoveryToolCallTimeoutMs(String(config.toolCallTimeoutMs));
  };

  const updateDiscoveryConfigMutation = useMutation({
    mutationFn: (payload: ServiceDiscoveryConfigUpdatePayload) =>
      apiFetch<ServiceDiscoveryConfigResponse>('/api/discovery/services/config', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: async (result) => {
      setDiscoveryError(null);
      setDiscoveryStatus('Saved service discovery configuration.');
      setDiscoveryConfigDirty(false);
      applyDiscoveryConfig(result.config);
      await queryClient.invalidateQueries({ queryKey: ['service-discovery-config'] });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Failed to save service discovery configuration.';
      setDiscoveryError(message);
    },
  });

  const runDiscoveryMutation = useMutation({
    mutationFn: (payload: ServiceDiscoveryRunRequestPayload) =>
      apiFetch<ServiceDiscoveryRunResponse>('/api/discovery/services/run', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: async (result) => {
      setDiscoveryError(null);
      setDiscoveryStatus(
        `Discovery run ${result.runId} completed: ${result.summary.detectedCount} detections, ${result.summary.upsertCount} upserts.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['service-discovery-config'] }),
        queryClient.invalidateQueries({ queryKey: ['service-discovery-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['services'] }),
        queryClient.invalidateQueries({ queryKey: ['links-suggestions'] }),
      ]);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to run service discovery.';
      setDiscoveryError(message);
    },
  });

  const deleteDiscoveryRunMutation = useMutation({
    mutationFn: ({ runId, payload }: { runId: string; payload: ServiceDiscoveryRunDelete }) =>
      apiFetch<ServiceDiscoveryRunDeleteResponse>(`/api/discovery/services/runs/${runId}`, {
        method: 'DELETE',
        body: JSON.stringify(payload),
      }),
    onSuccess: async (_result, variables) => {
      setDiscoveryError(null);
      setDiscoveryStatus(`Deleted discovery run ${variables.runId}.`);
      queryClient.setQueryData<ServiceDiscoveryRunHistoryResponse>(
        ['service-discovery-runs'],
        (current) =>
          current
            ? {
                runs: current.runs.filter((run) => run.id !== variables.runId),
              }
            : current,
      );
      if (selectedRunId === variables.runId) {
        setSelectedRunId(null);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['service-discovery-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['service-discovery-config'] }),
      ]);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Failed to delete discovery run.';
      setDiscoveryError(message);
    },
  });

  const discoveryConfigQuery = useQuery({
    queryKey: ['service-discovery-config'],
    queryFn: () => apiFetch<ServiceDiscoveryConfigResponse>('/api/discovery/services/config'),
    refetchInterval: (query) => {
      const payload = query.state.data as ServiceDiscoveryConfigResponse | undefined;
      return runDiscoveryMutation.isPending || payload?.isRunning ? 1_000 : 15_000;
    },
  });

  const discoveryRunsQuery = useQuery({
    queryKey: ['service-discovery-runs'],
    queryFn: () =>
      apiFetch<ServiceDiscoveryRunHistoryResponse>('/api/discovery/services/runs?limit=5'),
    refetchInterval: (query) => {
      if (isDiscoveryConfigEditing) {
        return false;
      }
      const payload = query.state.data as ServiceDiscoveryRunHistoryResponse | undefined;
      const latestStatus = payload?.runs?.[0]?.status;
      return runDiscoveryMutation.isPending || latestStatus === 'RUNNING' ? 1_000 : 5_000;
    },
  });
  const discoveryCatalogQuery = useQuery({
    queryKey: ['service-discovery-catalog'],
    queryFn: () => apiFetch<ServiceDiscoveryCatalogResponse>('/api/discovery/services/catalog'),
    refetchInterval: 60_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiFetch<DiscoveryAgent[]>('/api/agents'),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!discoveryConfigQuery.data || discoveryConfigDirty) {
      return;
    }
    applyDiscoveryConfig(discoveryConfigQuery.data.config);
  }, [discoveryConfigDirty, discoveryConfigQuery.data]);

  const discoveryRuns = useMemo(
    () => discoveryRunsQuery.data?.runs ?? [],
    [discoveryRunsQuery.data],
  );
  const latestDiscoveryRun = discoveryRuns[0] ?? null;
  const isDiscoveryRunning =
    runDiscoveryMutation.isPending ||
    latestDiscoveryRun?.status === 'RUNNING' ||
    discoveryConfigQuery.data?.isRunning === true;

  useEffect(() => {
    if (discoveryRuns.length === 0) {
      if (selectedRunId) {
        setSelectedRunId(null);
      }
      return;
    }

    if (!selectedRunId || !discoveryRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(discoveryRuns[0]?.id ?? null);
    }
  }, [discoveryRuns, selectedRunId]);

  const selectedRun = useMemo(() => {
    if (discoveryRuns.length === 0) {
      return null;
    }
    if (!selectedRunId) {
      return discoveryRuns[0] ?? null;
    }
    return discoveryRuns.find((run) => run.id === selectedRunId) ?? discoveryRuns[0] ?? null;
  }, [discoveryRuns, selectedRunId]);

  const selectedRunFindings = selectedRun
    ? buildServiceDiscoveryFindings({
        summary: selectedRun.summary,
        catalog: discoveryCatalogQuery.data,
      })
    : emptyFindingsSnapshot;
  const selectedRunConsole = selectedRun
    ? readDiscoveryConsoleSnapshot(selectedRun.summary)
    : emptyConsoleSnapshot;
  const discoveryConsoleLines = selectedRunConsole.entries.slice(-150);
  const parsedDiscoverySubnets = parseDiscoverySubnetInput(discoverySubnetText);
  const hasInvalidDiscoverySubnets = parsedDiscoverySubnets.invalid.length > 0;
  const showDetailedInvalidDiscoverySubnets =
    discoveryEnableSubnetScan &&
    hasInvalidDiscoverySubnets &&
    showDetailedDiscoverySubnetValidation;
  const showCompactInvalidDiscoverySubnets =
    discoveryEnableSubnetScan &&
    hasInvalidDiscoverySubnets &&
    !showDetailedDiscoverySubnetValidation;

  const nextScheduledRunAt = discoveryConfigQuery.data?.nextScheduledRunAt ?? null;
  const lastRunAt = discoveryConfigQuery.data?.lastRunAt ?? null;
  const configUpdatedAt = discoveryConfigQuery.data?.updatedAt ?? null;
  const discoveryIntervalSec = discoveryConfigQuery.data?.intervalSec ?? 0;
  const discoveryCatalogCount = discoveryCatalogQuery.data?.serviceCount ?? 0;

  const canDeleteDiscoveryRuns = true;
  const allAgents = agentsQuery.data ?? [];
  const onlineHostAgents = allAgents.filter(
    (agent) => agent.status === 'ONLINE' && !agent.revokedAt && Boolean(agent.hostId),
  );
  const canRunDiscoveryNow = onlineHostAgents.length > 0;
  const discoveryNoAgentMessage =
    'No online agents are enrolled to any host. Register and connect a labagent first.';

  /**
   * Builds config payload for the surrounding workflow.
   */
  const buildConfigPayload = (): ServiceDiscoveryConfig | null => {
    const maxHosts = Number(discoveryMaxHosts);
    const concurrency = Number(discoveryConcurrency);
    const connectTimeoutMs = Number(discoveryConnectTimeoutMs);
    const toolCallTimeoutMs = Number(discoveryToolCallTimeoutMs);

    if (!Number.isFinite(maxHosts) || maxHosts < 1 || maxHosts > 4096) {
      setDiscoveryError('Max hosts must be between 1 and 4096.');
      return null;
    }
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 128) {
      setDiscoveryError('Concurrency must be between 1 and 128.');
      return null;
    }
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 10000) {
      setDiscoveryError('Connect timeout must be between 100 and 10000 ms.');
      return null;
    }
    if (
      !Number.isFinite(toolCallTimeoutMs) ||
      toolCallTimeoutMs < 5000 ||
      toolCallTimeoutMs > 600000
    ) {
      setDiscoveryError('Tool call timeout must be between 5000 and 600000 ms.');
      return null;
    }

    if (discoveryEnableSubnetScan && parsedDiscoverySubnets.invalid.length > 0) {
      setShowDetailedDiscoverySubnetValidation(true);
      setDiscoveryError(
        `Invalid CIDR entries: ${parsedDiscoverySubnets.invalid.slice(0, 5).join(', ')}`,
      );
      return null;
    }

    return {
      enabled: discoveryEnableSubnetScan,
      cidrs: parsedDiscoverySubnets.subnets,
      includeAutoLocalCidrs: discoveryIncludeAutoLocalCidrs,
      includeCommonWebPorts: discoveryIncludeCommonWebPorts,
      maxHosts: Math.round(maxHosts),
      concurrency: Math.round(concurrency),
      connectTimeoutMs: Math.round(connectTimeoutMs),
      toolCallTimeoutMs: Math.round(toolCallTimeoutMs),
    };
  };

  /**
   * Handles save discovery config.
   */
  const handleSaveDiscoveryConfig = () => {
    setDiscoveryError(null);
    const config = buildConfigPayload();
    if (!config) {
      return;
    }
    updateDiscoveryConfigMutation.mutate({
      confirm: true,
      config,
    });
  };

  /**
   * Handles run discovery.
   */
  const handleRunDiscovery = () => {
    setDiscoveryError(null);
    if (isDiscoveryRunning) {
      return;
    }
    if (onlineHostAgents.length === 0) {
      setDiscoveryError(discoveryNoAgentMessage);
      return;
    }

    if (discoveryConfigDirty) {
      setDiscoveryError(
        'Save Service Discovery Configuration before running so scheduled and manual runs use the same settings.',
      );
      return;
    }

    runDiscoveryMutation.mutate({
      confirm: true,
    });
  };

  /**
   * Handles delete run.
   */
  const handleDeleteRun = (run: ServiceDiscoveryRunHistoryItem) => {
    if (deleteDiscoveryRunMutation.isPending || run.status === 'RUNNING') {
      return;
    }
    const confirmed = window.confirm(
      `Delete discovery run from ${new Date(run.startedAt).toLocaleString()}? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }
    setDiscoveryError(null);
    deleteDiscoveryRunMutation.mutate({
      runId: run.id,
      payload: {
        confirm: true,
      },
    });
  };

  if (
    discoveryConfigQuery.isLoading ||
    discoveryRunsQuery.isLoading ||
    discoveryCatalogQuery.isLoading ||
    agentsQuery.isLoading
  ) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Service Discovery</CardTitle>
              <CardDescription>
                Discover services across enrolled hosts and optional local subnets, then review
                structured findings in one place.
              </CardDescription>
            </div>
            {isDiscoveryRunning && (
              <div className="inline-flex items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs text-sky-200">
                <Loader2 className="h-3 w-3 animate-spin" />
                Discovery in progress
              </div>
            )}
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What Discovery Looks For</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Discovery combines passive host signals and active probes to identify known services.
          </p>
          <p>
            Passive checks inspect systemd units, container metadata, and process names already
            visible on connected hosts.
          </p>
          <p>
            Active checks use HTTP/TCP signatures from the catalog to verify likely matches and
            collect endpoints.
          </p>
          <p>
            Optional subnet scanning can probe configured CIDR ranges to find services on hosts that
            are not yet in inventory.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where Results Appear</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Findings from each run are shown below on this page with service, location, endpoint,
            confidence, source, and evidence.
          </p>
          <p>
            Persisted detections are also visible on Host detail pages under discovered services and
            instances.
          </p>
          <p>
            New upserts feed dashboard link suggestions, so newly discovered endpoints can be
            promoted to dashboard tiles.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Service Discovery Configuration</CardTitle>
          <CardDescription>
            One configuration governs both scheduled runs and Run Now. Save changes here to update
            all future discovery runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            <div>
              Catalog signatures available: {discoveryCatalogCount}. The built-in admin account can
              review history and trigger new discovery runs here.
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div>Next scheduled run: {formatOptionalDateTime(nextScheduledRunAt)}</div>
              <div>Last run: {formatOptionalDateTime(lastRunAt)}</div>
              <div>
                Schedule interval: {discoveryIntervalSec > 0 ? `${discoveryIntervalSec}s` : '-'}
              </div>
              <div>Config updated: {formatOptionalDateTime(configUpdatedAt)}</div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={discoveryEnableSubnetScan}
                onChange={(event) => {
                  setDiscoveryEnableSubnetScan(event.target.checked);
                  setDiscoveryConfigDirty(true);
                }}
              />
              Enable subnet scanning
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={discoveryIncludeCommonWebPorts}
                disabled={!discoveryEnableSubnetScan}
                onChange={(event) => {
                  setDiscoveryIncludeCommonWebPorts(event.target.checked);
                  setDiscoveryConfigDirty(true);
                }}
              />
              Probe common web ports (80/443/8080/8443)
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs md:col-span-2">
              <input
                type="checkbox"
                checked={discoveryIncludeAutoLocalCidrs}
                disabled={!discoveryEnableSubnetScan}
                onChange={(event) => {
                  setDiscoveryIncludeAutoLocalCidrs(event.target.checked);
                  setDiscoveryConfigDirty(true);
                }}
              />
              Include local interface CIDRs discovered by each agent
            </label>

            <div className="space-y-1 md:col-span-2">
              <div className="text-xs font-medium text-muted-foreground">
                Discovery Subnets (CIDR)
              </div>
              <Textarea
                value={discoverySubnetText}
                disabled={!discoveryEnableSubnetScan}
                className="resize-none"
                onFocus={() => setIsDiscoveryConfigEditing(true)}
                onBlur={() => {
                  setIsDiscoveryConfigEditing(false);
                  setShowDetailedDiscoverySubnetValidation(true);
                }}
                onChange={(event) => {
                  setDiscoverySubnetText(event.target.value);
                  setDiscoveryConfigDirty(true);
                  setShowDetailedDiscoverySubnetValidation(false);
                }}
                rows={4}
                placeholder="192.168.1.0/24"
              />
              <div className="text-[11px] text-muted-foreground">
                Enter one CIDR per line (or comma-separated). Default seeds: 10.0.0.0/24,
                172.16.0.0/24, 192.168.1.0/24.
              </div>
            </div>
          </div>

          <details className="rounded-md border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Advanced Options
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Max Hosts</div>
                <Input
                  value={discoveryMaxHosts}
                  disabled={!discoveryEnableSubnetScan}
                  onChange={(event) => {
                    setDiscoveryMaxHosts(event.target.value);
                    setDiscoveryConfigDirty(true);
                  }}
                  inputMode="numeric"
                  placeholder="512"
                />
                <div className="text-[11px] text-muted-foreground">Range: 1 to 4096.</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Concurrency</div>
                <Input
                  value={discoveryConcurrency}
                  disabled={!discoveryEnableSubnetScan}
                  onChange={(event) => {
                    setDiscoveryConcurrency(event.target.value);
                    setDiscoveryConfigDirty(true);
                  }}
                  inputMode="numeric"
                  placeholder="24"
                />
                <div className="text-[11px] text-muted-foreground">Range: 1 to 128.</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Connect Timeout (ms)
                </div>
                <Input
                  value={discoveryConnectTimeoutMs}
                  disabled={!discoveryEnableSubnetScan}
                  onChange={(event) => {
                    setDiscoveryConnectTimeoutMs(event.target.value);
                    setDiscoveryConfigDirty(true);
                  }}
                  inputMode="numeric"
                  placeholder="750"
                />
                <div className="text-[11px] text-muted-foreground">Range: 100 to 10000 ms.</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Tool Call Timeout (ms)
                </div>
                <Input
                  value={discoveryToolCallTimeoutMs}
                  disabled={!discoveryEnableSubnetScan}
                  onChange={(event) => {
                    setDiscoveryToolCallTimeoutMs(event.target.value);
                    setDiscoveryConfigDirty(true);
                  }}
                  inputMode="numeric"
                  placeholder="120000"
                />
                <div className="text-[11px] text-muted-foreground">Range: 5000 to 600000 ms.</div>
              </div>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={updateDiscoveryConfigMutation.isPending}
              onClick={handleSaveDiscoveryConfig}
            >
              {updateDiscoveryConfigMutation.isPending ? 'Saving...' : 'Save Configuration'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={updateDiscoveryConfigMutation.isPending}
              onClick={() => {
                setDiscoverySubnetText(defaultDiscoverySubnetSeeds.join('\n'));
                setDiscoveryEnableSubnetScan(true);
                setDiscoveryIncludeAutoLocalCidrs(false);
                setDiscoveryIncludeCommonWebPorts(true);
                setDiscoveryMaxHosts('512');
                setDiscoveryConcurrency('24');
                setDiscoveryConnectTimeoutMs('750');
                setDiscoveryToolCallTimeoutMs('120000');
                setDiscoveryConfigDirty(true);
              }}
            >
              Use Common Defaults
            </Button>
          </div>

          <div className="min-h-5 text-xs" aria-live="polite">
            {showDetailedInvalidDiscoverySubnets && (
              <span className="text-amber-300">
                Invalid CIDRs will be ignored:{' '}
                {parsedDiscoverySubnets.invalid.slice(0, 6).join(', ')}
              </span>
            )}
            {showCompactInvalidDiscoverySubnets && (
              <span className="text-amber-300">
                {parsedDiscoverySubnets.invalid.length} CIDR entr
                {parsedDiscoverySubnets.invalid.length === 1 ? 'y is' : 'ies are'} invalid.
              </span>
            )}
          </div>

          {discoveryConfigDirty && (
            <div className="text-xs text-amber-300">
              You have unsaved changes. Save configuration before running discovery.
            </div>
          )}
          {discoveryError && <div className="text-xs text-rose-400">{discoveryError}</div>}
          {discoveryStatus && (
            <div className="text-xs text-muted-foreground">{discoveryStatus}</div>
          )}
          {discoveryConfigQuery.isError && (
            <div className="text-xs text-rose-400">
              Failed to load service discovery configuration.
            </div>
          )}
          {discoveryCatalogQuery.isError && (
            <div className="text-xs text-rose-400">Failed to load discovery catalog metadata.</div>
          )}
          {discoveryRunsQuery.isError && (
            <div className="text-xs text-rose-400">Failed to load discovery run history.</div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button
              size="sm"
              disabled={
                !canRunDiscoveryNow || isDiscoveryRunning || updateDiscoveryConfigMutation.isPending
              }
              onClick={handleRunDiscovery}
            >
              {isDiscoveryRunning ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Running Discovery...
                </span>
              ) : (
                'Run Now'
              )}
            </Button>
            {!canRunDiscoveryNow && (
              <span className="text-xs text-rose-400">{discoveryNoAgentMessage}</span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Recent Runs</CardTitle>
              <Button size="sm" variant="outline" onClick={() => void discoveryRunsQuery.refetch()}>
                Refresh
              </Button>
            </div>
            <CardDescription>
              Latest 5 runs with status, duration, detections, and errors.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {discoveryRuns.length === 0 && (
              <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                No discovery runs yet.
              </div>
            )}
            {discoveryRuns.map((run) => {
              const isDeletingRun =
                deleteDiscoveryRunMutation.isPending &&
                deleteDiscoveryRunMutation.variables?.runId === run.id;
              return (
                <div
                  key={run.id}
                  className={`rounded-md border border-border/60 p-3 ${
                    selectedRun?.id === run.id ? 'border-sky-400/70 bg-sky-500/10' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-medium">{run.status}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatRunDuration(run)}
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {new Date(run.startedAt).toLocaleString()}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                        <span>det {run.detectedCount}</span>
                        <span>ups {run.upsertCount}</span>
                        <span>err {run.errorCount}</span>
                      </div>
                    </button>
                    {canDeleteDiscoveryRuns && (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        aria-label={`Delete run ${run.id}`}
                        disabled={run.status === 'RUNNING' || deleteDiscoveryRunMutation.isPending}
                        onClick={() => handleDeleteRun(run)}
                      >
                        {isDeletingRun ? 'Deleting...' : 'Delete'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Run Findings</CardTitle>
            <CardDescription>
              {selectedRun
                ? `${selectedRun.status} · ${new Date(selectedRun.startedAt).toLocaleString()}`
                : 'Select a run to inspect findings and console output.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!selectedRun && (
              <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                No run selected.
              </div>
            )}

            {selectedRun && (
              <>
                <div className="grid gap-2 rounded-md border border-border/60 p-3 text-xs md:grid-cols-5">
                  <div>Hosts: {selectedRun.hostCount}</div>
                  <div>Probes: {selectedRun.probeCount}</div>
                  <div>Detections: {selectedRun.detectedCount}</div>
                  <div>Upserts: {selectedRun.upsertCount}</div>
                  <div>Errors: {selectedRun.errorCount}</div>
                </div>

                {selectedRunFindings.warnings.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                    {selectedRunFindings.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                )}
                {selectedRunFindings.nonPersistedMessages.length > 0 && (
                  <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-xs text-sky-200">
                    Non-persisted detection notice: {selectedRunFindings.nonPersistedMessages[0]}
                  </div>
                )}

                {selectedRunFindings.isEmpty ? (
                  <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                    No detections were parsed for this run.
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border/60">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Service</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Endpoint</TableHead>
                          <TableHead>Confidence</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead>Evidence</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedRunFindings.rows.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell>{row.service}</TableCell>
                            <TableCell>{row.location}</TableCell>
                            <TableCell>{row.endpoint}</TableCell>
                            <TableCell>{row.confidence}</TableCell>
                            <TableCell>{row.source}</TableCell>
                            <TableCell>{row.evidence}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                <details className="rounded-md border border-border/60 bg-slate-950/95 p-3 font-mono text-[11px] text-slate-100">
                  <summary className="cursor-pointer font-sans text-xs uppercase tracking-wide text-slate-300">
                    Raw Console Logs
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-2 font-sans text-xs text-slate-300">
                      <span>{selectedRun.trigger}</span>
                      <span>·</span>
                      <span>{selectedRun.status}</span>
                      {selectedRunConsole.progress && (
                        <>
                          <span>·</span>
                          <span>stage {selectedRunConsole.progress.stage.replace(/-/g, ' ')}</span>
                          <span>·</span>
                          <span>
                            hosts {selectedRunConsole.progress.scannedHosts}/
                            {selectedRunConsole.progress.selectedHosts}
                          </span>
                          <span>·</span>
                          <span>probes {selectedRunConsole.progress.probes}</span>
                        </>
                      )}
                    </div>
                    {selectedRunConsole.truncated && (
                      <div className="text-[11px] text-amber-300">
                        Showing console tail only. Older entries were truncated.
                      </div>
                    )}
                    <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                      {discoveryConsoleLines.length === 0 && (
                        <div className="text-[11px] text-slate-400">
                          No console output is available for this run.
                        </div>
                      )}
                      {discoveryConsoleLines.map((line) => (
                        <div key={`${line.seq}-${line.timestamp}`} className="break-words">
                          <span className="text-slate-400">
                            [{new Date(line.timestamp).toLocaleTimeString()}]
                          </span>{' '}
                          <span
                            className={
                              line.level === 'ERROR'
                                ? 'text-rose-300'
                                : line.level === 'WARN'
                                  ? 'text-amber-300'
                                  : line.level === 'SUCCESS'
                                    ? 'text-emerald-300'
                                    : 'text-sky-300'
                            }
                          >
                            {line.level}
                          </span>{' '}
                          <span>{line.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Implements format run duration.
 */
function formatRunDuration(run: ServiceDiscoveryRunHistoryItem) {
  const started = Date.parse(run.startedAt);
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (!Number.isFinite(started)) {
    return '-';
  }
  if (!Number.isFinite(finished)) {
    return 'running';
  }
  const seconds = Math.max(0, Math.round((finished - started) / 1000));
  return `${seconds}s`;
}

/**
 * Implements format optional date time.
 */
function formatOptionalDateTime(value: string | null) {
  if (!value) {
    return '-';
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return '-';
  }
  return new Date(parsed).toLocaleString();
}

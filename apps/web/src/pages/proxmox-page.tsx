/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the proxmox page route view.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageSkeleton } from '@/components/page-skeleton';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  ProxmoxGuestAction,
  ProxmoxGuestActionRequest,
  ProxmoxGuestActionResponse,
  ProxmoxGuestDetailResponse,
  ProxmoxGuestInventoryResponse,
  ProxmoxGuestKind,
  ProxmoxGuestSummary,
  ProxmoxGuestTasksResponse,
  ProxmoxIntegrationSummary,
  ProxmoxTaskSummary,
} from '@/types/api';

type GuestTypeFilter = 'all' | ProxmoxGuestKind;
type GuestStatusFilter = 'all' | 'running' | 'stopped' | 'other';

type GuestSelection = {
  kind: ProxmoxGuestKind;
  vmid: number;
};

const guestActionLabels: Record<ProxmoxGuestAction, string> = {
  start: 'Start',
  shutdown: 'Shutdown',
  stop: 'Stop',
  reboot: 'Reboot',
};

const guestActionConfirmations: Record<ProxmoxGuestAction, (guestName: string) => string> = {
  start: (guestName) => `Start guest "${guestName}"?`,
  shutdown: (guestName) => `Send a graceful shutdown request to guest "${guestName}"?`,
  stop: (guestName) => `Force stop guest "${guestName}"? This may interrupt active work.`,
  reboot: (guestName) => `Reboot guest "${guestName}"?`,
};

/**
 * Builds guest key.
 */
function buildGuestKey(kind: ProxmoxGuestKind, vmid: number) {
  return `${kind}:${vmid}`;
}

/**
 * Implements format bytes.
 */
function formatBytes(value: number | null | undefined) {
  if (!Number.isFinite(value) || value === null || value === undefined || value <= 0) {
    return '-';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unitIndex = 0;
  let size = value;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Implements format timestamp.
 */
function formatTimestamp(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '-';
}

/**
 * Implements format duration.
 */
function formatDuration(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds) || seconds === null || seconds === undefined || seconds <= 0) {
    return '-';
  }

  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Implements normalize guest status.
 */
function normalizeGuestStatus(status: string | null | undefined): GuestStatusFilter {
  if (!status) {
    return 'other';
  }
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running') {
    return 'running';
  }
  if (normalized === 'stopped') {
    return 'stopped';
  }
  return 'other';
}

/**
 * Implements status badge class name.
 */
function statusBadgeClassName(status: string | null | undefined) {
  switch (normalizeGuestStatus(status)) {
    case 'running':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    case 'stopped':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-300';
    default:
      return 'border-border/60 text-muted-foreground';
  }
}

/**
 * Implements task is running.
 */
function taskIsRunning(task: ProxmoxTaskSummary | undefined, pendingUpid: string | null) {
  if (!task || !pendingUpid || task.upid !== pendingUpid) {
    return false;
  }
  return task.status?.trim().toLowerCase() === 'running';
}

/**
 * Implements action availability.
 */
function actionAvailability(guest: ProxmoxGuestSummary) {
  if (guest.template || guest.locked) {
    return [];
  }

  switch (normalizeGuestStatus(guest.status)) {
    case 'running':
      return ['shutdown', 'stop', 'reboot'] as ProxmoxGuestAction[];
    case 'stopped':
      return ['start'] as ProxmoxGuestAction[];
    default:
      return [] as ProxmoxGuestAction[];
  }
}

/**
 * Builds summary.
 */
function buildSummary(guests: ProxmoxGuestSummary[]) {
  return guests.reduce(
    (summary, guest) => {
      summary.total += 1;
      if (normalizeGuestStatus(guest.status) === 'running') {
        summary.running += 1;
      } else if (normalizeGuestStatus(guest.status) === 'stopped') {
        summary.stopped += 1;
      }
      if (guest.kind === 'qemu') {
        summary.qemu += 1;
      } else {
        summary.lxc += 1;
      }
      return summary;
    },
    { total: 0, running: 0, stopped: 0, qemu: 0, lxc: 0 },
  );
}

/**
 * Renders the proxmox page view.
 */
export function ProxmoxPage() {
  const queryClient = useQueryClient();
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [selectedGuestKey, setSelectedGuestKey] = useState<string | null>(null);
  const [guestTypeFilter, setGuestTypeFilter] = useState<GuestTypeFilter>('all');
  const [guestStatusFilter, setGuestStatusFilter] = useState<GuestStatusFilter>('all');
  const [nodeFilter, setNodeFilter] = useState('all');
  const [guestSearch, setGuestSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [pendingActionUpid, setPendingActionUpid] = useState<string | null>(null);

  const integrationsQuery = useQuery({
    queryKey: ['proxmox-integrations'],
    queryFn: () => apiFetch<ProxmoxIntegrationSummary[]>('/api/proxmox/integrations'),
  });

  useEffect(() => {
    const integrations = integrationsQuery.data ?? [];
    if (integrations.length === 0) {
      if (selectedIntegrationId) {
        setSelectedIntegrationId(null);
      }
      return;
    }

    const preferredIntegration =
      integrations.find((integration) => integration.id === selectedIntegrationId) ??
      integrations.find((integration) => integration.enabled) ??
      integrations[0];
    if (preferredIntegration && preferredIntegration.id !== selectedIntegrationId) {
      setSelectedIntegrationId(preferredIntegration.id);
    }
  }, [integrationsQuery.data, selectedIntegrationId]);

  const guestsQuery = useQuery({
    queryKey: ['proxmox-guests', selectedIntegrationId],
    queryFn: () =>
      apiFetch<ProxmoxGuestInventoryResponse>(
        `/api/proxmox/integrations/${selectedIntegrationId}/guests`,
      ),
    enabled: Boolean(selectedIntegrationId),
    refetchInterval: pendingActionUpid ? 2_000 : false,
  });

  const filteredGuests = useMemo(() => {
    const guests = guestsQuery.data?.guests ?? [];
    const normalizedSearch = guestSearch.trim().toLowerCase();
    return guests.filter((guest) => {
      if (guestTypeFilter !== 'all' && guest.kind !== guestTypeFilter) {
        return false;
      }
      if (guestStatusFilter !== 'all' && normalizeGuestStatus(guest.status) !== guestStatusFilter) {
        return false;
      }
      if (nodeFilter !== 'all' && guest.node !== nodeFilter) {
        return false;
      }
      if (
        normalizedSearch.length > 0 &&
        !`${guest.name} ${guest.vmid}`.toLowerCase().includes(normalizedSearch)
      ) {
        return false;
      }
      return true;
    });
  }, [guestSearch, guestStatusFilter, guestTypeFilter, guestsQuery.data?.guests, nodeFilter]);

  useEffect(() => {
    if (filteredGuests.length === 0) {
      if (selectedGuestKey) {
        setSelectedGuestKey(null);
      }
      return;
    }

    const selectedGuestStillVisible = filteredGuests.some(
      (guest) => buildGuestKey(guest.kind, guest.vmid) === selectedGuestKey,
    );
    if (!selectedGuestStillVisible) {
      setSelectedGuestKey(buildGuestKey(filteredGuests[0]!.kind, filteredGuests[0]!.vmid));
    }
  }, [filteredGuests, selectedGuestKey]);

  const selectedGuestSelection = useMemo<GuestSelection | null>(() => {
    if (!selectedGuestKey) {
      return null;
    }
    const [kind, vmidText] = selectedGuestKey.split(':');
    const vmid = Number(vmidText);
    if ((kind === 'qemu' || kind === 'lxc') && Number.isFinite(vmid)) {
      return {
        kind,
        vmid,
      };
    }
    return null;
  }, [selectedGuestKey]);

  const detailQuery = useQuery({
    queryKey: [
      'proxmox-guest-detail',
      selectedIntegrationId,
      selectedGuestSelection?.kind,
      selectedGuestSelection?.vmid,
    ],
    queryFn: () =>
      apiFetch<ProxmoxGuestDetailResponse>(
        `/api/proxmox/integrations/${selectedIntegrationId}/guests/${selectedGuestSelection?.kind}/${selectedGuestSelection?.vmid}`,
      ),
    enabled: Boolean(selectedIntegrationId && selectedGuestSelection),
    refetchInterval: pendingActionUpid ? 2_000 : false,
  });

  const tasksQuery = useQuery({
    queryKey: [
      'proxmox-guest-tasks',
      selectedIntegrationId,
      selectedGuestSelection?.kind,
      selectedGuestSelection?.vmid,
    ],
    queryFn: () =>
      apiFetch<ProxmoxGuestTasksResponse>(
        `/api/proxmox/integrations/${selectedIntegrationId}/guests/${selectedGuestSelection?.kind}/${selectedGuestSelection?.vmid}/tasks`,
      ),
    enabled: Boolean(selectedIntegrationId && selectedGuestSelection),
    refetchInterval: pendingActionUpid ? 2_000 : false,
  });

  useEffect(() => {
    if (!pendingActionUpid) {
      return;
    }
    const matchingTask = tasksQuery.data?.tasks.find((task) => task.upid === pendingActionUpid);
    if (!taskIsRunning(matchingTask, pendingActionUpid)) {
      setPendingActionUpid(null);
    }
  }, [pendingActionUpid, tasksQuery.data]);

  /**
   * Implements refresh queries.
   */
  const refreshQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['proxmox-integrations'] }),
      queryClient.invalidateQueries({ queryKey: ['proxmox-guests', selectedIntegrationId] }),
      queryClient.invalidateQueries({
        queryKey: [
          'proxmox-guest-detail',
          selectedIntegrationId,
          selectedGuestSelection?.kind,
          selectedGuestSelection?.vmid,
        ],
      }),
      queryClient.invalidateQueries({
        queryKey: [
          'proxmox-guest-tasks',
          selectedIntegrationId,
          selectedGuestSelection?.kind,
          selectedGuestSelection?.vmid,
        ],
      }),
    ]);
  };

  const actionMutation = useMutation({
    mutationFn: ({ action, guest }: { action: ProxmoxGuestAction; guest: ProxmoxGuestSummary }) =>
      apiFetch<ProxmoxGuestActionResponse>(
        `/api/proxmox/integrations/${selectedIntegrationId}/guests/${guest.kind}/${guest.vmid}/actions/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({ confirm: true } satisfies ProxmoxGuestActionRequest),
        },
      ),
    onMutate: () => {
      setActionError(null);
      setActionStatus(null);
    },
    onSuccess: async (result, variables) => {
      setActionStatus(
        `${guestActionLabels[variables.action]} requested for ${variables.guest.name}.`,
      );
      setPendingActionUpid(result.upid);
      await refreshQueries();
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : 'Failed to run the Proxmox action.');
    },
  });

  const selectedIntegration =
    integrationsQuery.data?.find((integration) => integration.id === selectedIntegrationId) ?? null;
  const summary = buildSummary(filteredGuests);
  const availableNodes =
    guestsQuery.data?.filters?.nodes ??
    Array.from(new Set((guestsQuery.data?.guests ?? []).map((guest) => guest.node))).sort();
  const selectedGuestSummary =
    filteredGuests.find(
      (guest) =>
        selectedGuestSelection &&
        guest.kind === selectedGuestSelection.kind &&
        guest.vmid === selectedGuestSelection.vmid,
    ) ?? null;
  const selectedGuestDetail = detailQuery.data?.guest ?? null;
  const selectedGuest = selectedGuestDetail ?? selectedGuestSummary;
  const availableActions = selectedGuest ? actionAvailability(selectedGuest) : [];
  const rawConfigJson = selectedGuestDetail
    ? JSON.stringify(selectedGuestDetail.rawConfig, null, 2)
    : '';

  if (integrationsQuery.isLoading) {
    return <PageSkeleton />;
  }

  if ((integrationsQuery.data ?? []).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Proxmox</CardTitle>
          <CardDescription>No enabled Proxmox integrations are available.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Add or enable a Proxmox integration in Settings before using the Proxmox management
            surface.
          </p>
          <Button asChild>
            <Link to="/settings">Open Settings</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1">
              <CardTitle>Proxmox</CardTitle>
              <CardDescription>
                Inspect live guest inventory, review recent tasks, and run basic lifecycle actions.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Integration
                </label>
                <Select
                  value={selectedIntegrationId ?? ''}
                  onChange={(event) => {
                    setSelectedIntegrationId(event.target.value);
                    setSelectedGuestKey(null);
                  }}
                >
                  {(integrationsQuery.data ?? []).map((integration) => (
                    <option key={integration.id} value={integration.id}>
                      {integration.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  void refreshQueries();
                }}
                disabled={guestsQuery.isFetching || detailQuery.isFetching || tasksQuery.isFetching}
              >
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge
              className={
                selectedIntegration?.enabled
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : ''
              }
            >
              {selectedIntegration?.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            {selectedIntegration?.allowInsecureTls ? (
              <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-300">
                Insecure TLS Allowed
              </Badge>
            ) : null}
            {selectedIntegration?.lastStatus ? (
              <Badge>{selectedIntegration.lastStatus}</Badge>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardDescription>Total Guests</CardDescription>
                <CardTitle>{summary.total}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardDescription>Running</CardDescription>
                <CardTitle>{summary.running}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardDescription>QEMU</CardDescription>
                <CardTitle>{summary.qemu}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardDescription>LXC</CardDescription>
                <CardTitle>{summary.lxc}</CardTitle>
              </CardHeader>
            </Card>
          </div>
          <div className="text-xs text-muted-foreground">
            {selectedIntegration?.baseUrl}
            {selectedIntegration?.lastSyncAt
              ? ` • last sync ${formatTimestamp(selectedIntegration.lastSyncAt)}`
              : ''}
          </div>
          {selectedIntegration?.lastError ? (
            <div className="text-xs text-rose-400">{selectedIntegration.lastError}</div>
          ) : null}
          {guestsQuery.error instanceof Error ? (
            <div className="text-xs text-rose-400">{guestsQuery.error.message}</div>
          ) : null}
          {detailQuery.error instanceof Error ? (
            <div className="text-xs text-rose-400">{detailQuery.error.message}</div>
          ) : null}
          {tasksQuery.error instanceof Error ? (
            <div className="text-xs text-rose-400">{tasksQuery.error.message}</div>
          ) : null}
          {actionError ? <div className="text-xs text-rose-400">{actionError}</div> : null}
          {actionStatus ? <div className="text-xs text-emerald-400">{actionStatus}</div> : null}
          {pendingActionUpid ? (
            <div className="text-xs text-muted-foreground">
              Waiting for task {pendingActionUpid} to finish. Guest detail and tasks are refreshing.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Guest Inventory</CardTitle>
            <CardDescription>Filter by type, state, node, or guest name.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Search
                </label>
                <Input
                  value={guestSearch}
                  onChange={(event) => setGuestSearch(event.target.value)}
                  placeholder="Search by name or VMID"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Type
                </label>
                <Select
                  value={guestTypeFilter}
                  onChange={(event) => setGuestTypeFilter(event.target.value as GuestTypeFilter)}
                >
                  <option value="all">All</option>
                  <option value="qemu">QEMU</option>
                  <option value="lxc">LXC</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  State
                </label>
                <Select
                  value={guestStatusFilter}
                  onChange={(event) =>
                    setGuestStatusFilter(event.target.value as GuestStatusFilter)
                  }
                >
                  <option value="all">All</option>
                  <option value="running">Running</option>
                  <option value="stopped">Stopped</option>
                  <option value="other">Other</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Node
                </label>
                <Select value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)}>
                  <option value="all">All Nodes</option>
                  {availableNodes.map((node) => (
                    <option key={node} value={node}>
                      {node}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="max-h-[640px] overflow-auto rounded-md border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>VMID</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredGuests.map((guest) => {
                    const guestKey = buildGuestKey(guest.kind, guest.vmid);
                    const isSelected = guestKey === selectedGuestKey;
                    return (
                      <TableRow
                        key={guestKey}
                        className={cn(isSelected && 'bg-primary/10')}
                        onClick={() => setSelectedGuestKey(guestKey)}
                      >
                        <TableCell className="cursor-pointer">
                          <div className="font-medium">{guest.name}</div>
                          {guest.template ? (
                            <div className="text-xs text-muted-foreground">Template</div>
                          ) : null}
                        </TableCell>
                        <TableCell>{guest.vmid}</TableCell>
                        <TableCell className="uppercase">{guest.kind}</TableCell>
                        <TableCell>{guest.node}</TableCell>
                        <TableCell>
                          <Badge className={statusBadgeClassName(guest.status)}>
                            {guest.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredGuests.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                        No guests matched the current filters.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Guest Detail</CardTitle>
              <CardDescription>
                Review the selected guest and run approved lifecycle actions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {detailQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading guest detail…</div>
              ) : !selectedGuest ? (
                <div className="text-sm text-muted-foreground">Select a guest to inspect it.</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-lg font-semibold">{selectedGuest.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {selectedGuest.kind.toUpperCase()} #{selectedGuest.vmid} on{' '}
                        {selectedGuest.node}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge className={statusBadgeClassName(selectedGuest.status)}>
                        {selectedGuest.status}
                      </Badge>
                      {selectedGuest.locked ? <Badge>Locked</Badge> : null}
                      {selectedGuest.template ? <Badge>Template</Badge> : null}
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <Card className="border-border/60">
                      <CardHeader className="pb-2">
                        <CardDescription>CPU</CardDescription>
                        <CardTitle>
                          {selectedGuest.cpu != null
                            ? `${(selectedGuest.cpu * 100).toFixed(1)}%`
                            : '-'}
                        </CardTitle>
                      </CardHeader>
                    </Card>
                    <Card className="border-border/60">
                      <CardHeader className="pb-2">
                        <CardDescription>Memory</CardDescription>
                        <CardTitle>{formatBytes(selectedGuest.memoryBytes)}</CardTitle>
                      </CardHeader>
                    </Card>
                    <Card className="border-border/60">
                      <CardHeader className="pb-2">
                        <CardDescription>Disk</CardDescription>
                        <CardTitle>{formatBytes(selectedGuest.diskBytes)}</CardTitle>
                      </CardHeader>
                    </Card>
                    <Card className="border-border/60">
                      <CardHeader className="pb-2">
                        <CardDescription>Uptime</CardDescription>
                        <CardTitle>{formatDuration(selectedGuest.uptimeSeconds)}</CardTitle>
                      </CardHeader>
                    </Card>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Lifecycle Actions
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {availableActions.map((action) => (
                        <Button
                          key={action}
                          variant={action === 'stop' ? 'danger' : 'outline'}
                          disabled={actionMutation.isPending}
                          onClick={() => {
                            if (!selectedGuest) {
                              return;
                            }
                            const confirmed = window.confirm(
                              guestActionConfirmations[action](selectedGuest.name),
                            );
                            if (!confirmed) {
                              return;
                            }
                            actionMutation.mutate({
                              action,
                              guest: selectedGuest,
                            });
                          }}
                        >
                          {actionMutation.isPending ? 'Submitting…' : guestActionLabels[action]}
                        </Button>
                      ))}
                      {availableActions.length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                          This guest has no lifecycle actions available in v1.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Config Summary
                    </div>
                    {selectedGuestDetail?.displayConfig?.length ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        {selectedGuestDetail.displayConfig.map((row) => (
                          <div
                            key={row.label}
                            className="rounded-md border border-border/60 px-3 py-2 text-sm"
                          >
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                              {row.label}
                            </div>
                            <div>{row.value}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        No additional config fields are available for this guest.
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Raw Config
                    </div>
                    <Textarea
                      value={rawConfigJson}
                      readOnly
                      rows={12}
                      className="font-mono text-xs"
                      placeholder="Detailed config appears after the guest detail loads."
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Tasks</CardTitle>
              <CardDescription>
                Latest recorded Proxmox tasks for the selected guest.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {tasksQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading tasks…</div>
              ) : (
                <div className="overflow-auto rounded-md border border-border/60">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Task</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead>Ended</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(tasksQuery.data?.tasks ?? []).map((task) => (
                        <TableRow key={task.upid}>
                          <TableCell>
                            <div className="font-medium">
                              {task.description ?? task.type ?? 'Task'}
                            </div>
                            <div className="text-xs text-muted-foreground">{task.upid}</div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={
                                taskIsRunning(task, pendingActionUpid)
                                  ? 'border-primary/40 bg-primary/10 text-primary'
                                  : ''
                              }
                            >
                              {task.status}
                            </Badge>
                          </TableCell>
                          <TableCell>{formatTimestamp(task.startedAt)}</TableCell>
                          <TableCell>{formatTimestamp(task.endedAt)}</TableCell>
                        </TableRow>
                      ))}
                      {(tasksQuery.data?.tasks ?? []).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                            No recent tasks are available for the selected guest.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the hosts page route view.
 */
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { HealthBadge } from '@/components/health-badge';
import { HostTerminalDialog } from '@/components/host-terminal-dialog';
import { PageSkeleton } from '@/components/page-skeleton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { parseAndValidateHostTags, parseHostTypeInput, type HostType } from '@/lib/host-metadata';
import type { UserPreferencesResponse } from '@/types/api';

type HostRow = {
  id: string;
  hostname: string;
  hostIp: string;
  tags: string[];
  status: string;
  cpuPct: number;
  memPct: number;
  diskPct: number;
  lastSeenAt: string | null;
  agentVersion: string;
  hasInstalledAgent: boolean;
  hostType: HostType;
};

type HostSortKey =
  | 'hostname'
  | 'ip'
  | 'type'
  | 'status'
  | 'cpu'
  | 'mem'
  | 'disk'
  | 'lastSeen'
  | 'agentVersion';
type HostSortDirection = 'asc' | 'desc';
type HostStatusFilter = 'all' | 'online' | 'offline';
type HostListColumnId =
  | 'index'
  | 'hostname'
  | 'ip'
  | 'tags'
  | 'type'
  | 'status'
  | 'cpu'
  | 'mem'
  | 'disk'
  | 'lastSeen'
  | 'agentVersion'
  | 'visibility'
  | 'terminal';
type HostListHideableColumnId =
  | 'ip'
  | 'tags'
  | 'type'
  | 'status'
  | 'cpu'
  | 'mem'
  | 'disk'
  | 'lastSeen'
  | 'agentVersion'
  | 'visibility';
type InlineField = 'tags' | 'type';

type HostMetadataResponse = {
  hostId: string;
  hostName: string;
  tags: string[];
  hostType: HostType;
  updatedAt: string;
};

const hostListColumnOrder: HostListColumnId[] = [
  'index',
  'hostname',
  'ip',
  'tags',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'lastSeen',
  'agentVersion',
  'visibility',
  'terminal',
];

const hostListHideableColumns: HostListHideableColumnId[] = [
  'ip',
  'tags',
  'type',
  'status',
  'cpu',
  'mem',
  'disk',
  'lastSeen',
  'agentVersion',
  'visibility',
];

const hostListColumnLabels: Record<HostListColumnId, string> = {
  index: '#',
  hostname: 'Hostname',
  ip: 'IP',
  tags: 'Tags',
  type: 'Type',
  status: 'Status',
  cpu: 'CPU%',
  mem: 'Mem%',
  disk: 'Disk%',
  lastSeen: 'Last Seen',
  agentVersion: 'Agent Version',
  visibility: 'Visibility',
  terminal: 'Terminal',
};

const hostListSortableColumns: Partial<Record<HostListColumnId, HostSortKey>> = {
  hostname: 'hostname',
  ip: 'ip',
  type: 'type',
  status: 'status',
  cpu: 'cpu',
  mem: 'mem',
  disk: 'disk',
  lastSeen: 'lastSeen',
  agentVersion: 'agentVersion',
};

const defaultColumnWidths: Record<HostListColumnId, number> = {
  index: 56,
  hostname: 220,
  ip: 170,
  tags: 260,
  type: 120,
  status: 120,
  cpu: 88,
  mem: 88,
  disk: 88,
  lastSeen: 220,
  agentVersion: 140,
  visibility: 110,
  terminal: 230,
};

const minColumnWidth = 80;
const maxColumnWidth = 640;

// Hosts inventory table with quick links to detail and SSH terminal access.
export function HostsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState<HostSortKey>('hostname');
  const [sortDirection, setSortDirection] = useState<HostSortDirection>('asc');
  const [hiddenColumnIds, setHiddenColumnIds] = useState<HostListHideableColumnId[]>([]);
  const [columnWidths, setColumnWidths] =
    useState<Record<HostListColumnId, number>>(defaultColumnWidths);
  const [activeEditor, setActiveEditor] = useState<{
    hostId: string;
    field: InlineField;
    value: string;
  } | null>(null);
  const [savingEditorKey, setSavingEditorKey] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<{ key: string; message: string } | null>(null);
  const committingEditorKeyRef = useRef<string | null>(null);
  const statusFilter = parseHostStatusFilter(searchParams.get('status'));

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => apiFetch<Array<Record<string, unknown>>>('/api/hosts'),
  });

  const preferencesQuery = useQuery({
    queryKey: ['user-preferences'],
    queryFn: () => apiFetch<UserPreferencesResponse>('/api/account/preferences'),
  });

  const saveHiddenHostsMutation = useMutation({
    mutationFn: (nextHiddenHostIds: string[]) =>
      apiFetch<UserPreferencesResponse>('/api/account/preferences/hidden-hosts', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          hiddenHostIds: nextHiddenHostIds,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-preferences'] });
    },
  });

  const saveColumnsMutation = useMutation({
    mutationFn: (payload: {
      hiddenColumnIds: HostListHideableColumnId[];
      widths: Array<{ id: HostListColumnId; widthPx: number }>;
    }) =>
      apiFetch<UserPreferencesResponse>('/api/account/preferences/host-list-columns', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          hostListColumns: {
            hiddenColumnIds: payload.hiddenColumnIds,
            widths: payload.widths,
          },
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-preferences'] });
    },
  });

  const hiddenHostIds = useMemo(() => {
    const ids = preferencesQuery.data?.preferences.hiddenHostIds ?? [];
    return new Set(ids);
  }, [preferencesQuery.data?.preferences.hiddenHostIds]);

  const allRows = useMemo(
    () => (hostsQuery.data ?? []).map((host) => normalizeHostRow(host)),
    [hostsQuery.data],
  );
  const rowsById = useMemo(() => {
    const map = new Map<string, HostRow>();
    for (const row of allRows) {
      map.set(row.id, row);
    }
    return map;
  }, [allRows]);

  const visibleRows = useMemo(
    () => (showHidden ? allRows : allRows.filter((host) => !hiddenHostIds.has(host.id))),
    [allRows, hiddenHostIds, showHidden],
  );

  const statusCounts = useMemo(
    () => ({
      all: visibleRows.length,
      online: visibleRows.filter((host) => isHostOnline(host.status)).length,
      offline: visibleRows.filter((host) => !isHostOnline(host.status)).length,
    }),
    [visibleRows],
  );

  const filteredRows = useMemo(() => {
    if (statusFilter === 'online') {
      return visibleRows.filter((host) => isHostOnline(host.status));
    }
    if (statusFilter === 'offline') {
      return visibleRows.filter((host) => !isHostOnline(host.status));
    }
    return visibleRows;
  }, [statusFilter, visibleRows]);

  const sortedRows = useMemo(
    () =>
      [...filteredRows].sort((left, right) => compareHosts(left, right, sortKey, sortDirection)),
    [filteredRows, sortDirection, sortKey],
  );

  useEffect(() => {
    const stored = preferencesQuery.data?.preferences.hostListColumns;
    if (!stored) {
      return;
    }

    const nextHidden = dedupeHiddenColumns(stored.hiddenColumnIds);
    const nextWidths = { ...defaultColumnWidths };
    for (const width of stored.widths) {
      nextWidths[width.id] = clampColumnWidth(width.widthPx);
    }

    setHiddenColumnIds(nextHidden);
    setColumnWidths(nextWidths);
  }, [preferencesQuery.data?.updatedAt, preferencesQuery.data?.preferences.hostListColumns]);

  if (hostsQuery.isLoading || preferencesQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (hostsQuery.isError || !hostsQuery.data) {
    return <div className="text-sm text-rose-400">Failed to load hosts.</div>;
  }

  if (preferencesQuery.isError || !preferencesQuery.data) {
    return <div className="text-sm text-rose-400">Failed to load host visibility preferences.</div>;
  }

  const hiddenCount = hiddenHostIds.size;
  const hiddenColumnSet = new Set(hiddenColumnIds);
  const visibleColumnIds = hostListColumnOrder.filter(
    (id) => !isHideableColumn(id) || !hiddenColumnSet.has(id as HostListHideableColumnId),
  );

  /**
   * Sets status filter.
   */
  const setStatusFilter = (next: HostStatusFilter) => {
    const nextParams = new URLSearchParams(searchParams);
    if (next === 'all') {
      nextParams.delete('status');
    } else {
      nextParams.set('status', next);
    }
    setSearchParams(nextParams);
  };

  /**
   * Sets sort.
   */
  const setSort = (nextKey: HostSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDirection('asc');
  };

  /**
   * Implements hide host.
   */
  const hideHost = (hostId: string) => {
    if (saveHiddenHostsMutation.isPending) {
      return;
    }
    const next = new Set(hiddenHostIds);
    next.add(hostId);
    saveHiddenHostsMutation.mutate(Array.from(next));
  };

  /**
   * Implements unhide host.
   */
  const unhideHost = (hostId: string) => {
    if (saveHiddenHostsMutation.isPending) {
      return;
    }
    const next = new Set(hiddenHostIds);
    next.delete(hostId);
    saveHiddenHostsMutation.mutate(Array.from(next));
  };

  /**
   * Implements unhide all.
   */
  const unhideAll = () => {
    if (saveHiddenHostsMutation.isPending) {
      return;
    }
    saveHiddenHostsMutation.mutate([]);
  };

  const persistColumnPreferences = (
    nextHiddenColumns: HostListHideableColumnId[],
    nextWidths: Record<HostListColumnId, number>,
  ) => {
    saveColumnsMutation.mutate({
      hiddenColumnIds: nextHiddenColumns,
      widths: hostListColumnOrder.map((id) => ({
        id,
        widthPx: clampColumnWidth(nextWidths[id]),
      })),
    });
  };

  /**
   * Implements toggle column visibility.
   */
  const toggleColumnVisibility = (columnId: HostListHideableColumnId) => {
    const next = hiddenColumnIds.includes(columnId)
      ? hiddenColumnIds.filter((entry) => entry !== columnId)
      : [...hiddenColumnIds, columnId];
    const deduped = dedupeHiddenColumns(next);
    setHiddenColumnIds(deduped);
    persistColumnPreferences(deduped, columnWidths);
  };

  /**
   * Implements reset columns.
   */
  const resetColumns = () => {
    setHiddenColumnIds([]);
    setColumnWidths(defaultColumnWidths);
    persistColumnPreferences([], defaultColumnWidths);
  };

  /**
   * Implements start column resize.
   */
  const startColumnResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    columnId: HostListColumnId,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[columnId];

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    /**
     * Handles mouse move.
     */
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const widthDelta = moveEvent.clientX - startX;
      const nextWidth = clampColumnWidth(startWidth + widthDelta);
      setColumnWidths((current) => ({
        ...current,
        [columnId]: nextWidth,
      }));
    };

    /**
     * Handles mouse up.
     */
    const handleMouseUp = (upEvent: MouseEvent) => {
      const widthDelta = upEvent.clientX - startX;
      const nextWidth = clampColumnWidth(startWidth + widthDelta);
      const nextWidths = {
        ...columnWidths,
        [columnId]: nextWidth,
      };
      setColumnWidths(nextWidths);
      persistColumnPreferences(hiddenColumnIds, nextWidths);

      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  /**
   * Implements begin inline edit.
   */
  const beginInlineEdit = (host: HostRow, field: InlineField) => {
    const value = field === 'tags' ? host.tags.join(', ') : host.hostType.toLowerCase();
    setEditorError(null);
    setActiveEditor({
      hostId: host.id,
      field,
      value,
    });
  };

  /**
   * Implements commit inline edit.
   */
  const commitInlineEdit = async (hostId: string, field: InlineField, rawValue: string) => {
    const host = rowsById.get(hostId);
    if (!host) {
      setActiveEditor(null);
      return;
    }

    const key = buildEditorKey(host.id, field);
    if (committingEditorKeyRef.current === key) {
      return;
    }

    let nextTags = host.tags;
    let nextHostType = host.hostType;

    try {
      if (field === 'tags') {
        nextTags = parseAndValidateHostTags(rawValue);
      } else {
        nextHostType = parseHostTypeInput(rawValue);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Invalid host metadata value.';
      setEditorError({ key, message });
      return;
    }

    const unchanged =
      nextHostType === host.hostType &&
      nextTags.length === host.tags.length &&
      nextTags.every((tag, index) => tag === host.tags[index]);

    if (unchanged) {
      setActiveEditor(null);
      setEditorError(null);
      return;
    }

    committingEditorKeyRef.current = key;
    setSavingEditorKey(key);
    setEditorError(null);

    try {
      await apiFetch<HostMetadataResponse>(`/api/hosts/${host.id}/metadata`, {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          tags: nextTags,
          hostType: nextHostType,
        }),
      });

      setActiveEditor(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hosts'] }),
        queryClient.invalidateQueries({ queryKey: ['host', host.id] }),
      ]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Failed to save host metadata.';
      setEditorError({ key, message });
    } finally {
      if (committingEditorKeyRef.current === key) {
        committingEditorKeyRef.current = null;
      }
      setSavingEditorKey(null);
    }
  };

  /**
   * Renders the render header view.
   */
  const renderHeader = (columnId: HostListColumnId) => {
    const width = columnWidths[columnId];
    const sortCandidate = hostListSortableColumns[columnId];
    return (
      <TableHead
        key={columnId}
        className="relative"
        style={{
          width,
          minWidth: width,
        }}
      >
        {sortCandidate ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => setSort(sortCandidate)}
          >
            <span>{hostListColumnLabels[columnId]}</span>
            {!isSortActive(sortCandidate, sortKey) && (
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            {isSortActive(sortCandidate, sortKey) && sortDirection === 'asc' && (
              <ArrowUp className="h-3.5 w-3.5" />
            )}
            {isSortActive(sortCandidate, sortKey) && sortDirection === 'desc' && (
              <ArrowDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span>{hostListColumnLabels[columnId]}</span>
        )}

        <button
          type="button"
          className="absolute right-0 top-0 h-full w-2 cursor-col-resize border-r border-transparent transition hover:border-border"
          aria-label={`Resize ${hostListColumnLabels[columnId]} column`}
          onMouseDown={(event) => startColumnResize(event, columnId)}
          onClick={(event) => event.stopPropagation()}
        />
      </TableHead>
    );
  };

  /**
   * Renders the render inline cell view.
   */
  const renderInlineCell = (host: HostRow, field: InlineField) => {
    const key = buildEditorKey(host.id, field);
    const isEditing = activeEditor?.hostId === host.id && activeEditor.field === field;
    const isSaving = savingEditorKey === key;
    const errorText = editorError?.key === key ? editorError.message : null;
    const displayValue =
      field === 'tags'
        ? host.tags.length > 0
          ? host.tags.join(', ')
          : '-'
        : host.hostType === 'CONTAINER'
          ? 'Container'
          : 'Machine';
    const editorValue = activeEditor?.value ?? '';

    if (!isEditing) {
      return (
        <div className="space-y-1">
          <button
            type="button"
            className="max-w-full truncate rounded px-1 text-left text-sm hover:bg-secondary/50"
            onClick={() => beginInlineEdit(host, field)}
            disabled={isSaving}
          >
            {displayValue}
          </button>
          {isSaving && <div className="text-[11px] text-muted-foreground">Saving...</div>}
          {errorText && <div className="text-[11px] text-rose-400">{errorText}</div>}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <Input
          autoFocus
          value={editorValue}
          onChange={(event) => {
            setActiveEditor((current) => {
              if (!current || current.hostId !== host.id || current.field !== field) {
                return current;
              }
              return {
                ...current,
                value: event.target.value,
              };
            });
          }}
          onBlur={() => {
            void commitInlineEdit(host.id, field, editorValue);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setActiveEditor(null);
              setEditorError(null);
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              void commitInlineEdit(host.id, field, editorValue);
            }
          }}
          placeholder={field === 'tags' ? 'edge, proxmox, rack-1' : 'machine or container'}
          disabled={isSaving}
        />
        <div className="text-[11px] text-muted-foreground">
          Press Enter to save or Esc to cancel.
        </div>
        {errorText && <div className="text-[11px] text-rose-400">{errorText}</div>}
      </div>
    );
  };

  /**
   * Renders the render cell view.
   */
  const renderCell = (
    columnId: HostListColumnId,
    host: HostRow,
    rowIndex: number,
    isHiddenHost: boolean,
  ) => {
    if (columnId === 'index') {
      return <TableCell key={columnId}>{rowIndex + 1}</TableCell>;
    }
    if (columnId === 'hostname') {
      return (
        <TableCell key={columnId}>
          <Link to={`/hosts/${host.id}`} className="font-medium">
            {host.hostname}
          </Link>
        </TableCell>
      );
    }
    if (columnId === 'ip') {
      return <TableCell key={columnId}>{host.hostIp}</TableCell>;
    }
    if (columnId === 'tags') {
      return <TableCell key={columnId}>{renderInlineCell(host, 'tags')}</TableCell>;
    }
    if (columnId === 'type') {
      return <TableCell key={columnId}>{renderInlineCell(host, 'type')}</TableCell>;
    }
    if (columnId === 'status') {
      return (
        <TableCell key={columnId}>
          <HealthBadge status={host.status} />
        </TableCell>
      );
    }
    if (columnId === 'cpu') {
      return <TableCell key={columnId}>{host.cpuPct.toFixed(1)}</TableCell>;
    }
    if (columnId === 'mem') {
      return <TableCell key={columnId}>{host.memPct.toFixed(1)}</TableCell>;
    }
    if (columnId === 'disk') {
      return <TableCell key={columnId}>{host.diskPct.toFixed(1)}</TableCell>;
    }
    if (columnId === 'lastSeen') {
      return (
        <TableCell key={columnId}>
          {host.lastSeenAt ? new Date(host.lastSeenAt).toLocaleString() : '-'}
        </TableCell>
      );
    }
    if (columnId === 'agentVersion') {
      return <TableCell key={columnId}>{host.agentVersion}</TableCell>;
    }
    if (columnId === 'visibility') {
      return (
        <TableCell key={columnId}>
          {isHiddenHost ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => unhideHost(host.id)}>
              Unhide
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={() => hideHost(host.id)}>
              Hide
            </Button>
          )}
        </TableCell>
      );
    }

    return (
      <TableCell key={columnId}>
        <div className="flex flex-wrap items-center gap-1">
          <HostTerminalDialog
            hostId={host.id}
            hostName={host.hostname}
            hostTarget={host.hostIp === '-' ? host.hostname : host.hostIp}
            triggerLabel="Open"
          />
          {host.hasInstalledAgent ? (
            <span className="text-xs font-medium text-muted-foreground">Agent Installed</span>
          ) : (
            <Button type="button" size="sm" variant="secondary" asChild>
              <Link
                to={`/agent-management?installHostId=${encodeURIComponent(host.id)}&installHost=${encodeURIComponent(
                  host.hostIp === '-' ? host.hostname : host.hostIp,
                )}&installUsername=${encodeURIComponent('root')}`}
              >
                Install Agent
              </Link>
            </Button>
          )}
        </div>
      </TableCell>
    );
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle>Hosts</CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowHidden((current) => !current)}
          >
            {showHidden ? 'Hide hidden hosts' : `Show hidden hosts (${hiddenCount})`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={hiddenCount === 0}
            onClick={unhideAll}
          >
            Unhide all
          </Button>
          <Button
            type="button"
            size="sm"
            variant={statusFilter === 'all' ? 'secondary' : 'outline'}
            onClick={() => setStatusFilter('all')}
          >
            All statuses ({statusCounts.all})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={statusFilter === 'online' ? 'secondary' : 'outline'}
            onClick={() => setStatusFilter('online')}
          >
            /** * Handles online. */ Online ({statusCounts.online})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={statusFilter === 'offline' ? 'secondary' : 'outline'}
            onClick={() => setStatusFilter('offline')}
          >
            /** * Handles offline. */ Offline ({statusCounts.offline})
          </Button>

          <details className="relative">
            <summary className="inline-flex cursor-pointer select-none items-center rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/40">
              Columns
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-64 space-y-2 rounded-md border border-border/60 bg-card p-3 shadow-md">
              {hostListHideableColumns.map((columnId) => {
                const checked = !hiddenColumnSet.has(columnId);
                return (
                  <label key={columnId} className="flex items-center justify-between gap-2 text-xs">
                    <span>{hostListColumnLabels[columnId]}</span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleColumnVisibility(columnId)}
                    />
                  </label>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                onClick={resetColumns}
              >
                Reset columns
              </Button>
            </div>
          </details>

          {saveHiddenHostsMutation.isPending && (
            <span className="text-muted-foreground">Saving host visibility...</span>
          )}
          {saveHiddenHostsMutation.isError && (
            <span className="text-rose-400">Failed to update host visibility.</span>
          )}
          {saveColumnsMutation.isPending && (
            <span className="text-muted-foreground">Saving column preferences...</span>
          )}
          {saveColumnsMutation.isError && (
            <span className="text-rose-400">Failed to save column preferences.</span>
          )}
        </div>
      </CardHeader>

      <CardContent className="overflow-x-auto">
        <Table className="table-fixed">
          <colgroup>
            {visibleColumnIds.map((columnId) => (
              <col
                key={columnId}
                style={{
                  width: columnWidths[columnId],
                  minWidth: columnWidths[columnId],
                }}
              />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow>{visibleColumnIds.map((columnId) => renderHeader(columnId))}</TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.map((host, rowIndex) => {
              const isHiddenHost = hiddenHostIds.has(host.id);
              return (
                <TableRow key={host.id} className={isHiddenHost ? 'opacity-60' : ''}>
                  {visibleColumnIds.map((columnId) =>
                    renderCell(columnId, host, rowIndex, isHiddenHost),
                  )}
                </TableRow>
              );
            })}
            {sortedRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={visibleColumnIds.length}
                  className="text-center text-muted-foreground"
                >
                  No hosts match the current filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Implements normalize host row.
 */
function normalizeHostRow(host: Record<string, unknown>): HostRow {
  const tags = Array.isArray(host.tags) ? host.tags.map((tag) => String(tag)) : [];
  const hostType = String(host.hostType ?? '')
    .trim()
    .toUpperCase();
  return {
    id: String(host.id ?? ''),
    hostname: String(host.hostname ?? 'unknown'),
    hostIp: String(host.hostIp ?? '-'),
    tags,
    status: String(host.status ?? 'UNKNOWN'),
    cpuPct: Number(host.cpuPct ?? 0),
    memPct: Number(host.memPct ?? 0),
    diskPct: Number(host.diskPct ?? 0),
    lastSeenAt: host.lastSeenAt ? String(host.lastSeenAt) : null,
    agentVersion: String(host.agentVersion ?? '-'),
    hasInstalledAgent: Boolean(
      host.agent &&
      typeof host.agent === 'object' &&
      !Array.isArray(host.agent) &&
      (host.agent as { revokedAt?: unknown }).revokedAt == null,
    ),
    hostType:
      hostType === 'CONTAINER'
        ? 'CONTAINER'
        : hostType === 'MACHINE'
          ? 'MACHINE'
          : inferHostTypeFromTags(tags),
  };
}

/**
 * Implements infer host type from tags.
 */
function inferHostTypeFromTags(tags: string[]): HostType {
  const normalized = tags.map((tag) => tag.toLowerCase().trim());
  if (
    normalized.some((tag) =>
      ['container', 'docker', 'podman', 'lxc', 'kube', 'kubernetes', 'containerd'].some((marker) =>
        tag.includes(marker),
      ),
    )
  ) {
    return 'CONTAINER';
  }
  return 'MACHINE';
}

/**
 * Parses host status filter.
 */
function parseHostStatusFilter(raw: string | null): HostStatusFilter {
  if (raw === 'online' || raw === 'offline') {
    return raw;
  }
  return 'all';
}

/**
 * Checks whether host online.
 */
function isHostOnline(status: string) {
  return status.trim().toUpperCase() === 'OK';
}

/**
 * Implements compare hosts.
 */
function compareHosts(
  left: HostRow,
  right: HostRow,
  key: HostSortKey,
  direction: HostSortDirection,
) {
  const order = direction === 'asc' ? 1 : -1;
  if (key === 'cpu' || key === 'mem' || key === 'disk') {
    const leftValue = key === 'cpu' ? left.cpuPct : key === 'mem' ? left.memPct : left.diskPct;
    const rightValue = key === 'cpu' ? right.cpuPct : key === 'mem' ? right.memPct : right.diskPct;
    return (leftValue - rightValue) * order;
  }
  if (key === 'lastSeen') {
    const leftValue = left.lastSeenAt ? new Date(left.lastSeenAt).getTime() : 0;
    const rightValue = right.lastSeenAt ? new Date(right.lastSeenAt).getTime() : 0;
    return (leftValue - rightValue) * order;
  }

  const leftValue =
    key === 'hostname'
      ? left.hostname
      : key === 'ip'
        ? left.hostIp
        : key === 'type'
          ? left.hostType
          : key === 'status'
            ? left.status
            : left.agentVersion;
  const rightValue =
    key === 'hostname'
      ? right.hostname
      : key === 'ip'
        ? right.hostIp
        : key === 'type'
          ? right.hostType
          : key === 'status'
            ? right.status
            : right.agentVersion;

  return leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' }) * order;
}

/**
 * Implements clamp column width.
 */
function clampColumnWidth(value: number) {
  return Math.max(minColumnWidth, Math.min(maxColumnWidth, Math.round(value)));
}

/**
 * Implements dedupe hidden columns.
 */
function dedupeHiddenColumns(hiddenColumnIds: HostListHideableColumnId[]) {
  const deduped: HostListHideableColumnId[] = [];
  const seen = new Set<string>();
  for (const columnId of hiddenColumnIds) {
    if (seen.has(columnId)) {
      continue;
    }
    if (!hostListHideableColumns.includes(columnId)) {
      continue;
    }
    seen.add(columnId);
    deduped.push(columnId);
  }
  return deduped;
}

/**
 * Checks whether hideable column.
 */
function isHideableColumn(columnId: HostListColumnId): columnId is HostListHideableColumnId {
  return hostListHideableColumns.includes(columnId as HostListHideableColumnId);
}

/**
 * Checks whether sort active.
 */
function isSortActive(candidate: HostSortKey, currentSortKey: HostSortKey) {
  return candidate === currentSortKey;
}

/**
 * Builds editor key.
 */
function buildEditorKey(hostId: string, field: InlineField) {
  return `${hostId}:${field}`;
}

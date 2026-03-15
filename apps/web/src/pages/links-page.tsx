/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the links page route view.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bot,
  Cloud,
  Container,
  Database,
  ExternalLink,
  GitBranch,
  Globe,
  GripVertical,
  HardDrive,
  Home,
  Network,
  Pencil,
  Plus,
  Router,
  Save,
  Server,
  Shield,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { HostTerminalDialog } from '@/components/host-terminal-dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import { getToken } from '@/lib/auth';
import { formatTimeAgo, formatTimestamp } from '@/lib/time';
import { cn } from '@/lib/utils';
import { apiBaseUrl } from '@/lib/utils';
import type {
  AgentRecoverySummaryResponse,
  DashboardAgentHighlightsResponse,
  HostMetricWidget,
  HomelabMetricId,
  HomelabMetricWidget,
  HomeSummaryResponse,
  KnownLinkIconId,
  LinkWidget,
  LinkWidgetMetricId,
  HostTerminalWidget,
  LinkWidgetSizeId,
  LinkGroup,
  LinkGroupColorId,
  LinksDashboard,
  LinksDashboardResponse,
  LinkSuggestion,
  LinkSuggestionsResponse,
  LinkTile,
  LinkTileSizeId,
  UserPreferencesResponse,
} from '@/types/api';

// Dashboard page that combines user-managed link tiles with live control-plane
// widgets (host metrics, homelab metrics, AI questions, and SSH launchers).
type TileFormValues = {
  title: string;
  url: string;
  description: string;
  icon: KnownLinkIconId;
  openInNewTab: boolean;
  targetGroupId: string;
};

type TileEditorState = {
  mode: 'create' | 'edit';
  sourceGroupId: string;
  tileId?: string;
  values: TileFormValues;
};

type WidgetEditorKind =
  | 'host-metric'
  | 'homelab-metric'
  | 'host-terminal'
  | 'home-whats-broken'
  | 'home-recent-events'
  | 'home-top-consumers'
  | 'dashboard-agent-highlights'
  | 'ai-chat';

type WidgetFormValues = {
  kind: WidgetEditorKind;
  title: string;
  description: string;
  targetGroupId: string;
  hostId: string;
  metric: LinkWidgetMetricId;
  homelabMetric: HomelabMetricId;
  aiQuestion: string;
  aiRefreshIntervalSec: string;
  size: LinkWidgetSizeId;
};

type WidgetEditorState = {
  mode: 'create' | 'edit';
  sourceGroupId: string;
  widgetId?: string;
  values: WidgetFormValues;
};

type HostFact = {
  createdAt?: string;
  snapshot?: unknown;
};

type MetricPoint = {
  at: number;
  value: number;
};

type DragPayload =
  | { type: 'group'; groupId: string }
  | { type: 'tile'; groupId: string; tileId: string };

const fallbackGroupColors: LinkGroupColorId[] = [
  'slate',
  'blue',
  'teal',
  'emerald',
  'amber',
  'rose',
  'violet',
];

const fallbackKnownIcons: Array<{ id: KnownLinkIconId; label: string }> = [
  { id: 'globe', label: 'Generic Service' },
  { id: 'shield', label: 'Security / DNS' },
  { id: 'wrench', label: 'Automation' },
  { id: 'chart', label: 'Observability' },
  { id: 'activity', label: 'Metrics' },
  { id: 'server', label: 'Infrastructure' },
  { id: 'network', label: 'Network' },
  { id: 'hard-drive', label: 'Storage' },
  { id: 'home', label: 'Smart Home' },
  { id: 'container', label: 'Containers' },
  { id: 'git', label: 'Source Control' },
  { id: 'cloud', label: 'Cloud / Sync' },
  { id: 'database', label: 'Database' },
  { id: 'router', label: 'Routing / Proxy' },
  { id: 'terminal', label: 'Admin' },
  { id: 'bot', label: 'Automation Bot' },
];

const tileSizeClassNames: Record<LinkTileSizeId, string> = {
  sm: 'p-2 text-xs',
  md: 'p-3 text-sm',
  lg: 'p-4 text-sm',
};

const widgetSizeLabels: Array<{ value: LinkWidgetSizeId; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
  { value: 'tall', label: 'Tall' },
];

const iconById: Record<KnownLinkIconId, LucideIcon> = {
  globe: Globe,
  shield: Shield,
  wrench: Wrench,
  chart: BarChart3,
  activity: Activity,
  server: Server,
  network: Network,
  'hard-drive': HardDrive,
  home: Home,
  container: Container,
  git: GitBranch,
  cloud: Cloud,
  database: Database,
  router: Router,
  terminal: Terminal,
  bot: Bot,
};

const groupToneClassName: Record<LinkGroupColorId, string> = {
  slate: 'border-slate-400/35 bg-slate-500/5',
  blue: 'border-blue-400/35 bg-blue-500/5',
  teal: 'border-teal-400/35 bg-teal-500/5',
  emerald: 'border-emerald-400/35 bg-emerald-500/5',
  amber: 'border-amber-400/35 bg-amber-500/5',
  rose: 'border-rose-400/35 bg-rose-500/5',
  violet: 'border-violet-400/35 bg-violet-500/5',
};

/**
 * Renders the links page view.
 */
export function LinksPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<LinksDashboard | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [newGroupTitle, setNewGroupTitle] = useState('');
  const [tileEditor, setTileEditor] = useState<TileEditorState | null>(null);
  const [tileEditorError, setTileEditorError] = useState<string | null>(null);
  const [widgetEditor, setWidgetEditor] = useState<WidgetEditorState | null>(null);
  const [widgetEditorError, setWidgetEditorError] = useState<string | null>(null);
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);

  const dashboardQuery = useQuery({
    queryKey: ['links-dashboard'],
    queryFn: () => apiFetch<LinksDashboardResponse>('/api/links/dashboard'),
  });

  const suggestionsQuery = useQuery({
    queryKey: ['links-suggestions'],
    queryFn: () => apiFetch<LinkSuggestionsResponse>('/api/links/suggestions'),
  });

  const preferencesQuery = useQuery({
    queryKey: ['user-preferences'],
    queryFn: () => apiFetch<UserPreferencesResponse>('/api/account/preferences'),
  });

  const orphanRecoverySummaryQuery = useQuery({
    queryKey: ['agent-recovery-summary'],
    queryFn: () => apiFetch<AgentRecoverySummaryResponse>('/api/agent-recovery/summary'),
    refetchInterval: 30_000,
  });

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => apiFetch<Array<Record<string, unknown>>>('/api/hosts'),
  });

  const existingUrls = useMemo(
    () =>
      new Set(
        (draft?.groups ?? []).flatMap((group) =>
          group.tiles.map((tile) => normalizeUrlKey(tile.url)),
        ),
      ),
    [draft],
  );

  useEffect(() => {
    const initial = dashboardQuery.data?.dashboard;
    if (initial) {
      setDraft(cloneDashboard(initial));
    }
  }, [dashboardQuery.data?.dashboard]);

  useEffect(() => {
    if (editMode) {
      return;
    }
    setDragPayload(null);
    setNewGroupTitle('');
    setTileEditor(null);
    setTileEditorError(null);
    setWidgetEditor(null);
    setWidgetEditorError(null);
  }, [editMode]);

  const saveMutation = useMutation({
    mutationFn: (dashboard: LinksDashboard) =>
      apiFetch<LinksDashboardResponse>('/api/links/dashboard', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          dashboard,
        }),
      }),
    onSuccess: async (result) => {
      setDraft(cloneDashboard(result.dashboard));
      setEditMode(false);
      await queryClient.invalidateQueries({ queryKey: ['links-dashboard'] });
      await queryClient.invalidateQueries({ queryKey: ['links-suggestions'] });
    },
  });

  const dismissSuggestionsNoticeMutation = useMutation({
    mutationFn: (fingerprint: string) =>
      apiFetch<UserPreferencesResponse>('/api/account/preferences/dashboard-suggestions-notice', {
        method: 'PUT',
        body: JSON.stringify({
          confirm: true,
          dismissedFingerprint: fingerprint,
        }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-preferences'] });
    },
  });

  const dismissOrphanRecoveryNoticeMutation = useMutation({
    mutationFn: (fingerprint: string) =>
      apiFetch<UserPreferencesResponse>(
        '/api/account/preferences/dashboard-orphan-recovery-notice',
        {
          method: 'PUT',
          body: JSON.stringify({
            confirm: true,
            dismissedFingerprint: fingerprint,
          }),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-preferences'] });
    },
  });

  if (dashboardQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (dashboardQuery.isError || !dashboardQuery.data || !draft) {
    return <div className="text-sm text-rose-400">Failed to load dashboard.</div>;
  }

  const baseline = dashboardQuery.data.dashboard;
  const isDirty = !areDashboardsEqual(baseline, draft);
  const knownIcons =
    dashboardQuery.data.knownIcons.length > 0
      ? dashboardQuery.data.knownIcons
      : suggestionsQuery.data?.knownIcons.length
        ? suggestionsQuery.data.knownIcons
        : fallbackKnownIcons;
  const groupColors =
    dashboardQuery.data.groupColors.length > 0
      ? dashboardQuery.data.groupColors
      : fallbackGroupColors;
  const suggestions = suggestionsQuery.data?.suggestions ?? [];
  const pendingSuggestions = suggestions.filter(
    (suggestion) => !existingUrls.has(normalizeUrlKey(suggestion.url)),
  );
  const pendingSuggestionFingerprint = fingerprintPendingSuggestions(pendingSuggestions);
  const dismissedSuggestionFingerprint =
    preferencesQuery.data?.preferences.dashboardSuggestionsNotice.dismissedFingerprint ?? null;
  const orphanRecoverySummary = orphanRecoverySummaryQuery.data;
  const dismissedOrphanRecoveryFingerprint =
    preferencesQuery.data?.preferences.dashboardOrphanRecoveryNotice.dismissedFingerprint ?? null;
  const showOrphanRecoveryNotice =
    !editMode &&
    !orphanRecoverySummaryQuery.isError &&
    !preferencesQuery.isLoading &&
    !preferencesQuery.isError &&
    (orphanRecoverySummary?.pendingApprovalCount ?? 0) > 0 &&
    Boolean(orphanRecoverySummary?.pendingApprovalFingerprint) &&
    orphanRecoverySummary?.pendingApprovalFingerprint !== dismissedOrphanRecoveryFingerprint;
  const showSuggestionsNotice =
    !editMode &&
    pendingSuggestions.length > 0 &&
    Boolean(pendingSuggestionFingerprint) &&
    !preferencesQuery.isLoading &&
    !preferencesQuery.isError &&
    pendingSuggestionFingerprint !== dismissedSuggestionFingerprint;
  const hosts = hostsQuery.data ?? [];
  const hostsById = new Map<string, string>();
  for (const host of hosts) {
    const id = typeof host.id === 'string' ? host.id : '';
    if (!id) {
      continue;
    }
    hostsById.set(id, String(host.hostname ?? id));
  }

  /**
   * Implements apply dashboard update.
   */
  const applyDashboardUpdate = (updater: (current: LinksDashboard) => LinksDashboard) => {
    // Centralizes immutable updates so edit operations share one code path.
    setDraft((current) => (current ? updater(current) : current));
  };

  /**
   * Implements clear drag.
   */
  const clearDrag = () => setDragPayload(null);

  /**
   * Creates drag start handler.
   */
  const createDragStartHandler = (payload: DragPayload) => (event: DragEvent<HTMLDivElement>) => {
    if (!editMode) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', '');
    setDragPayload(payload);
  };

  /**
   * Handles group drop.
   */
  const handleGroupDrop = (targetGroupId: string) => (event: DragEvent<HTMLDivElement>) => {
    if (!editMode) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!dragPayload || dragPayload.type !== 'group' || dragPayload.groupId === targetGroupId) {
      clearDrag();
      return;
    }

    applyDashboardUpdate((current) => ({
      ...current,
      groups: reorderGroupsById(current.groups, dragPayload.groupId, targetGroupId),
    }));

    clearDrag();
  };

  const handleTileDrop =
    (targetGroupId: string, targetTileId?: string) => (event: DragEvent<HTMLDivElement>) => {
      if (!editMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!dragPayload || dragPayload.type !== 'tile') {
        clearDrag();
        return;
      }

      applyDashboardUpdate((current) =>
        moveTileById(current, dragPayload.groupId, dragPayload.tileId, targetGroupId, targetTileId),
      );

      clearDrag();
    };

  /**
   * Implements add group.
   */
  const addGroup = () => {
    const title = newGroupTitle.trim();
    if (!title) {
      return;
    }

    applyDashboardUpdate((current) => ({
      ...current,
      groups: [
        ...current.groups,
        {
          id: createLocalId(),
          title,
          color: 'slate',
          collapsed: false,
          tiles: [],
          widgets: [],
        },
      ],
    }));

    setNewGroupTitle('');
  };

  /**
   * Implements remove group.
   */
  const removeGroup = (groupIndex: number) => {
    applyDashboardUpdate((current) => {
      if (current.groups.length <= 1) {
        return current;
      }

      const groupToRemove = current.groups[groupIndex];
      if (!groupToRemove) {
        return current;
      }

      const destinationBeforeDelete = groupIndex === 0 ? 1 : groupIndex - 1;
      const nextGroups = current.groups.filter((_, index) => index !== groupIndex);
      const destinationAfterDelete = groupIndex === 0 ? 0 : destinationBeforeDelete;
      const destinationGroup = nextGroups[destinationAfterDelete];
      if (!destinationGroup) {
        return current;
      }

      nextGroups[destinationAfterDelete] = {
        ...destinationGroup,
        tiles: [...destinationGroup.tiles, ...groupToRemove.tiles],
        widgets: [...(destinationGroup.widgets ?? []), ...(groupToRemove.widgets ?? [])],
      };

      return {
        ...current,
        groups: nextGroups,
      };
    });
  };

  /**
   * Implements move group.
   */
  const moveGroup = (groupIndex: number, direction: -1 | 1) => {
    applyDashboardUpdate((current) => ({
      ...current,
      groups: moveInArray(current.groups, groupIndex, groupIndex + direction),
    }));
  };

  /**
   * Implements move tile.
   */
  const moveTile = (groupId: string, tileId: string, direction: -1 | 1) => {
    applyDashboardUpdate((current) => {
      const groupIndex = current.groups.findIndex((group) => group.id === groupId);
      if (groupIndex < 0) {
        return current;
      }

      const group = current.groups[groupIndex];
      if (!group) {
        return current;
      }

      const tileIndex = group.tiles.findIndex((tile) => tile.id === tileId);
      if (tileIndex < 0) {
        return current;
      }

      const nextGroups = current.groups.map((entry, index) =>
        index === groupIndex
          ? {
              ...entry,
              tiles: moveInArray(entry.tiles, tileIndex, tileIndex + direction),
            }
          : entry,
      );

      return {
        ...current,
        groups: nextGroups,
      };
    });
  };

  /**
   * Implements remove tile.
   */
  const removeTile = (groupId: string, tileId: string) => {
    applyDashboardUpdate((current) => ({
      ...current,
      groups: current.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              tiles: group.tiles.filter((tile) => tile.id !== tileId),
            }
          : group,
      ),
    }));
  };

  /**
   * Implements move widget.
   */
  const moveWidget = (groupId: string, widgetId: string, direction: -1 | 1) => {
    applyDashboardUpdate((current) => {
      const groupIndex = current.groups.findIndex((group) => group.id === groupId);
      if (groupIndex < 0) {
        return current;
      }

      const group = current.groups[groupIndex];
      if (!group) {
        return current;
      }

      const widgets = group.widgets ?? [];
      const widgetIndex = widgets.findIndex((widget) => widget.id === widgetId);
      if (widgetIndex < 0) {
        return current;
      }

      const nextGroups = current.groups.map((entry, index) =>
        index === groupIndex
          ? {
              ...entry,
              widgets: moveInArray(entry.widgets ?? [], widgetIndex, widgetIndex + direction),
            }
          : entry,
      );

      return {
        ...current,
        groups: nextGroups,
      };
    });
  };

  /**
   * Implements remove widget.
   */
  const removeWidget = (groupId: string, widgetId: string) => {
    applyDashboardUpdate((current) => ({
      ...current,
      groups: current.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              widgets: (group.widgets ?? []).filter((widget) => widget.id !== widgetId),
            }
          : group,
      ),
    }));
  };

  /**
   * Opens create host widget for the surrounding workflow.
   */
  const openCreateHostWidget = (groupId: string, metric: LinkWidgetMetricId = 'cpu') => {
    const firstHost = hosts[0];
    const firstHostId = typeof firstHost?.id === 'string' ? firstHost.id : '';
    const firstHostName = typeof firstHost?.hostname === 'string' ? firstHost.hostname : '';
    setWidgetEditorError(null);
    setWidgetEditor({
      mode: 'create',
      sourceGroupId: groupId,
      values: {
        kind: 'host-metric',
        title: firstHostName
          ? `${firstHostName} ${metricLabel(metric)}`
          : `Host ${metricLabel(metric)}`,
        description: 'Live metric trend from host telemetry.',
        targetGroupId: groupId,
        hostId: firstHostId,
        metric,
        homelabMetric: 'hostsOnline',
        aiQuestion: 'What should I look at first right now?',
        aiRefreshIntervalSec: '',
        size: 'wide',
      },
    });
  };

  /**
   * Opens create homelab widget for the surrounding workflow.
   */
  const openCreateHomelabWidget = (groupId: string, metric: HomelabMetricId = 'hostsOnline') => {
    setWidgetEditorError(null);
    setWidgetEditor({
      mode: 'create',
      sourceGroupId: groupId,
      values: {
        kind: 'homelab-metric',
        title: homelabMetricLabel(metric),
        description: 'Calculated from current homelab state in the control plane database.',
        targetGroupId: groupId,
        hostId: '',
        metric: 'cpu',
        homelabMetric: metric,
        aiQuestion: 'What should I look at first right now?',
        aiRefreshIntervalSec: '',
        size: 'normal',
      },
    });
  };

  /**
   * Implements open create widget.
   */
  const openCreateWidget = (groupId: string) => {
    if (hosts.length > 0) {
      openCreateHostWidget(groupId);
      return;
    }

    openCreateHomelabWidget(groupId);
  };

  /**
   * Implements open edit widget.
   */
  const openEditWidget = (groupId: string, widget: LinkWidget) => {
    setWidgetEditorError(null);
    if (widget.kind === 'host-metric') {
      setWidgetEditor({
        mode: 'edit',
        sourceGroupId: groupId,
        widgetId: widget.id,
        values: {
          kind: 'host-metric',
          title: widget.title,
          description: widget.description ?? '',
          targetGroupId: groupId,
          hostId: widget.hostId,
          metric: widget.metric,
          homelabMetric: 'hostsOnline',
          aiQuestion: 'What should I look at first right now?',
          aiRefreshIntervalSec: '',
          size: widget.size ?? 'normal',
        },
      });
      return;
    }

    if (widget.kind === 'host-terminal') {
      setWidgetEditor({
        mode: 'edit',
        sourceGroupId: groupId,
        widgetId: widget.id,
        values: {
          kind: 'host-terminal',
          title: widget.title,
          description: widget.description ?? '',
          targetGroupId: groupId,
          hostId: widget.hostId,
          metric: 'cpu',
          homelabMetric: 'hostsOnline',
          aiQuestion: 'What should I look at first right now?',
          aiRefreshIntervalSec: '',
          size: widget.size ?? 'normal',
        },
      });
      return;
    }

    if (widget.kind === 'homelab-metric' || widget.kind === 'home-summary-card') {
      setWidgetEditor({
        mode: 'edit',
        sourceGroupId: groupId,
        widgetId: widget.id,
        values: {
          kind: 'homelab-metric',
          title: widget.title,
          description: widget.description ?? '',
          targetGroupId: groupId,
          hostId: '',
          metric: 'cpu',
          homelabMetric: widget.metric,
          aiQuestion: 'What should I look at first right now?',
          aiRefreshIntervalSec: '',
          size: widget.size ?? 'normal',
        },
      });
      return;
    }

    if (
      widget.kind === 'home-whats-broken' ||
      widget.kind === 'home-recent-events' ||
      widget.kind === 'home-top-consumers'
    ) {
      setWidgetEditor({
        mode: 'edit',
        sourceGroupId: groupId,
        widgetId: widget.id,
        values: {
          kind: widget.kind,
          title: widget.title,
          description: widget.description ?? '',
          targetGroupId: groupId,
          hostId: '',
          metric: 'cpu',
          homelabMetric: 'hostsOnline',
          aiQuestion: 'What should I look at first right now?',
          aiRefreshIntervalSec: '',
          size: widget.size ?? 'normal',
        },
      });
      return;
    }

    if (widget.kind === 'dashboard-agent-highlights') {
      setWidgetEditor({
        mode: 'edit',
        sourceGroupId: groupId,
        widgetId: widget.id,
        values: {
          kind: 'dashboard-agent-highlights',
          title: widget.title,
          description: widget.description ?? '',
          targetGroupId: groupId,
          hostId: '',
          metric: 'cpu',
          homelabMetric: 'hostsOnline',
          aiQuestion: 'What should I look at first right now?',
          aiRefreshIntervalSec: '',
          size: widget.size ?? 'wide',
        },
      });
      return;
    }

    setWidgetEditor({
      mode: 'edit',
      sourceGroupId: groupId,
      widgetId: widget.id,
      values: {
        kind: 'ai-chat',
        title: widget.title,
        description: widget.description ?? '',
        targetGroupId: groupId,
        hostId: '',
        metric: 'cpu',
        homelabMetric: 'hostsOnline',
        aiQuestion: widget.kind === 'ai-chat' ? widget.question : '',
        aiRefreshIntervalSec:
          widget.kind === 'ai-chat' && typeof widget.refreshIntervalSec === 'number'
            ? String(widget.refreshIntervalSec)
            : '',
        size: widget.size ?? 'normal',
      },
    });
  };

  /**
   * Implements save widget editor.
   */
  const saveWidgetEditor = () => {
    if (!widgetEditor) {
      return;
    }

    const error = validateWidgetForm(widgetEditor.values, hostsById);
    if (error) {
      setWidgetEditorError(error);
      return;
    }

    applyDashboardUpdate((current) => {
      // Handles create/edit flows and supports moving widgets between groups.
      const sourceGroupIndex = current.groups.findIndex(
        (group) => group.id === widgetEditor.sourceGroupId,
      );
      if (sourceGroupIndex < 0) {
        return current;
      }

      const sourceGroup = current.groups[sourceGroupIndex];
      if (!sourceGroup) {
        return current;
      }

      const hostName =
        widgetEditor.values.kind === 'host-metric' || widgetEditor.values.kind === 'host-terminal'
          ? (hostsById.get(widgetEditor.values.hostId) ?? widgetEditor.values.hostId)
          : '';

      let nextWidget: LinkWidget;
      if (widgetEditor.values.kind === 'host-metric') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'host-metric',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          hostId: widgetEditor.values.hostId,
          hostName,
          metric: widgetEditor.values.metric,
          size: widgetEditor.values.size,
        };
      } else if (widgetEditor.values.kind === 'homelab-metric') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'homelab-metric',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          metric: widgetEditor.values.homelabMetric,
          size: widgetEditor.values.size,
        };
      } else if (widgetEditor.values.kind === 'host-terminal') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'host-terminal',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          hostId: widgetEditor.values.hostId,
          hostName,
          size: widgetEditor.values.size,
        };
      } else if (widgetEditor.values.kind === 'home-whats-broken') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'home-whats-broken',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          size: widgetEditor.values.size,
        };
      } else if (widgetEditor.values.kind === 'home-recent-events') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'home-recent-events',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          size: widgetEditor.values.size,
        };
      } else if (widgetEditor.values.kind === 'home-top-consumers') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'home-top-consumers',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          size: widgetEditor.values.size,
        };
      } else if (widgetEditor.values.kind === 'dashboard-agent-highlights') {
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'dashboard-agent-highlights',
          title: widgetEditor.values.title.trim(),
          description: widgetEditor.values.description.trim() || undefined,
          size: widgetEditor.values.size,
        };
      } else {
        const question = widgetEditor.values.aiQuestion.trim();
        const refreshIntervalSec = parseAiRefreshInterval(widgetEditor.values.aiRefreshIntervalSec);
        nextWidget = {
          id: widgetEditor.widgetId ?? createLocalId(),
          kind: 'ai-chat',
          title: makeAiWidgetTitle(question),
          description: buildAiWidgetDescription(refreshIntervalSec),
          question,
          refreshIntervalSec,
          size: widgetEditor.values.size,
        };
      }

      const removeFromSource = current.groups.map((group, groupIndex) =>
        groupIndex === sourceGroupIndex
          ? {
              ...group,
              widgets: (group.widgets ?? []).filter(
                (widget) => widget.id !== widgetEditor.widgetId,
              ),
            }
          : group,
      );

      const targetGroupIndex = removeFromSource.findIndex(
        (group) => group.id === widgetEditor.values.targetGroupId,
      );
      if (targetGroupIndex < 0) {
        return current;
      }

      const nextGroups = removeFromSource.map((group, groupIndex) =>
        groupIndex === targetGroupIndex
          ? {
              ...group,
              widgets: [...(group.widgets ?? []), nextWidget],
            }
          : group,
      );

      return {
        ...current,
        groups: nextGroups,
      };
    });

    setWidgetEditor(null);
    setWidgetEditorError(null);
  };

  /**
   * Implements open create tile editor.
   */
  const openCreateTileEditor = (groupId: string, suggestion?: LinkSuggestion) => {
    setTileEditorError(null);
    setTileEditor({
      mode: 'create',
      sourceGroupId: groupId,
      values: {
        title: suggestion?.title ?? '',
        url: suggestion?.url ?? 'http://',
        description: suggestion?.description ?? '',
        icon: suggestion?.icon ?? 'globe',
        openInNewTab: draft.settings.defaultOpenInNewTab,
        targetGroupId: groupId,
      },
    });
  };

  /**
   * Implements open edit tile editor.
   */
  const openEditTileEditor = (groupId: string, tile: LinkTile) => {
    setTileEditorError(null);
    setTileEditor({
      mode: 'edit',
      sourceGroupId: groupId,
      tileId: tile.id,
      values: {
        title: tile.title,
        url: tile.url,
        description: tile.description ?? '',
        icon: tile.icon,
        openInNewTab: tile.openInNewTab,
        targetGroupId: groupId,
      },
    });
  };

  /**
   * Implements add suggestion.
   */
  const addSuggestion = (suggestion: LinkSuggestion) => {
    const matchedGroupIndex = draft.groups.findIndex(
      (group) => group.title.trim().toLowerCase() === suggestion.groupHint.toLowerCase(),
    );
    const groupIndex = matchedGroupIndex >= 0 ? matchedGroupIndex : 0;
    const targetGroup = draft.groups[groupIndex];
    if (!targetGroup) {
      return;
    }

    openCreateTileEditor(targetGroup.id, suggestion);
  };

  /**
   * Implements save tile editor.
   */
  const saveTileEditor = () => {
    if (!tileEditor) {
      return;
    }

    const error = validateTileForm(tileEditor.values);
    if (error) {
      setTileEditorError(error);
      return;
    }

    const normalizedUrl = normalizeUrl(tileEditor.values.url);
    if (!normalizedUrl) {
      setTileEditorError('URL must be a valid http:// or https:// address.');
      return;
    }

    const description = tileEditor.values.description.trim();

    applyDashboardUpdate((current) => {
      if (tileEditor.mode === 'create') {
        const targetGroupIndex = current.groups.findIndex(
          (group) => group.id === tileEditor.values.targetGroupId,
        );
        if (targetGroupIndex < 0) {
          return current;
        }

        const targetGroup = current.groups[targetGroupIndex];
        if (!targetGroup) {
          return current;
        }

        const nextTile: LinkTile = {
          id: createLocalId(),
          title: tileEditor.values.title.trim(),
          url: normalizedUrl,
          description: description || undefined,
          icon: tileEditor.values.icon,
          openInNewTab: tileEditor.values.openInNewTab,
        };

        const nextGroups = current.groups.map((group, index) =>
          index === targetGroupIndex
            ? {
                ...group,
                tiles: [...group.tiles, nextTile],
              }
            : group,
        );

        return {
          ...current,
          groups: nextGroups,
        };
      }

      // Edit flow can update in place or move a tile across groups.
      const sourceGroupIndex = current.groups.findIndex(
        (group) => group.id === tileEditor.sourceGroupId,
      );
      if (sourceGroupIndex < 0) {
        return current;
      }

      const sourceGroup = current.groups[sourceGroupIndex];
      if (!sourceGroup) {
        return current;
      }

      const tileIndex = sourceGroup.tiles.findIndex((tile) => tile.id === tileEditor.tileId);
      if (tileIndex < 0) {
        return current;
      }

      const existingTile = sourceGroup.tiles[tileIndex];
      if (!existingTile) {
        return current;
      }

      const updatedTile: LinkTile = {
        ...existingTile,
        title: tileEditor.values.title.trim(),
        url: normalizedUrl,
        description: description || undefined,
        icon: tileEditor.values.icon,
        openInNewTab: tileEditor.values.openInNewTab,
      };

      if (tileEditor.values.targetGroupId === tileEditor.sourceGroupId) {
        const nextGroups = current.groups.map((group, groupIndex) =>
          groupIndex === sourceGroupIndex
            ? {
                ...group,
                tiles: group.tiles.map((tile, index) => (index === tileIndex ? updatedTile : tile)),
              }
            : group,
        );

        return {
          ...current,
          groups: nextGroups,
        };
      }

      const targetGroupIndex = current.groups.findIndex(
        (group) => group.id === tileEditor.values.targetGroupId,
      );
      if (targetGroupIndex < 0) {
        return current;
      }

      const nextGroups = current.groups.map((group, groupIndex) => {
        if (groupIndex === sourceGroupIndex) {
          return {
            ...group,
            tiles: group.tiles.filter((tile) => tile.id !== existingTile.id),
          };
        }
        if (groupIndex === targetGroupIndex) {
          return {
            ...group,
            tiles: [...group.tiles, updatedTile],
          };
        }
        return group;
      });

      return {
        ...current,
        groups: nextGroups,
      };
    });

    setTileEditor(null);
    setTileEditorError(null);
  };

  /**
   * Implements enter edit mode.
   */
  const enterEditMode = () => {
    setEditMode(true);
  };

  /**
   * Checks whether cancel edit mode.
   */
  const cancelEditMode = () => {
    setDraft(cloneDashboard(baseline));
    setEditMode(false);
  };

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Your primary homelab view. Enter edit mode to customize groups, tiles, widgets, and
              layout.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!editMode && (
              <Button type="button" onClick={enterEditMode}>
                Edit Dashboard
              </Button>
            )}
            {editMode && (
              <>
                <Button type="button" variant="secondary" onClick={cancelEditMode}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!isDirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate(draft)}
                >
                  <Save className="mr-1 h-4 w-4" />
                  {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
              </>
            )}
          </div>
        </div>

        {showOrphanRecoveryNotice && orphanRecoverySummary && (
          <div className="rounded-md border border-rose-400/60 bg-rose-500/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-medium text-rose-200">
                  Orphaned agents are waiting for review.
                </div>
                <div className="text-xs text-rose-100/90">
                  {orphanRecoverySummary.pendingApprovalCount} pending recovery claim
                  {orphanRecoverySummary.pendingApprovalCount === 1 ? '' : 's'} detected.
                  {orphanRecoverySummary.pendingClaimsPreview.length > 0 && (
                    <>
                      {' '}
                      Review{' '}
                      {orphanRecoverySummary.pendingClaimsPreview
                        .map((claim) => claim.label)
                        .join(', ')}
                      .
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="secondary" asChild>
                  <Link to="/agent-management">Review Claims</Link>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    dismissOrphanRecoveryNoticeMutation.isPending ||
                    !orphanRecoverySummary.pendingApprovalFingerprint
                  }
                  onClick={() => {
                    if (!orphanRecoverySummary.pendingApprovalFingerprint) {
                      return;
                    }
                    dismissOrphanRecoveryNoticeMutation.mutate(
                      orphanRecoverySummary.pendingApprovalFingerprint,
                    );
                  }}
                >
                  {dismissOrphanRecoveryNoticeMutation.isPending ? 'Dismissing...' : 'Dismiss'}
                </Button>
              </div>
            </div>
            {dismissOrphanRecoveryNoticeMutation.isError && (
              <div className="mt-2 text-xs text-rose-400">Failed to dismiss this notice.</div>
            )}
          </div>
        )}

        {showSuggestionsNotice && (
          <div className="rounded-md border border-amber-400/60 bg-amber-500/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-medium text-amber-300">
                  New suggested links are available.
                </div>
                <div className="text-xs text-amber-200/90">
                  {pendingSuggestions.length} new suggestion
                  {pendingSuggestions.length === 1 ? '' : 's'} detected from discovery data.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={enterEditMode}>
                  Review Suggestions
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    dismissSuggestionsNoticeMutation.isPending || !pendingSuggestionFingerprint
                  }
                  onClick={() => {
                    if (!pendingSuggestionFingerprint) {
                      return;
                    }
                    dismissSuggestionsNoticeMutation.mutate(pendingSuggestionFingerprint);
                  }}
                >
                  {dismissSuggestionsNoticeMutation.isPending ? 'Dismissing...' : 'Dismiss'}
                </Button>
              </div>
            </div>
            {dismissSuggestionsNoticeMutation.isError && (
              <div className="mt-2 text-xs text-rose-400">Failed to dismiss this notice.</div>
            )}
          </div>
        )}

        {editMode && (
          <div className="space-y-3 rounded-md border border-border/60 bg-card/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={String(draft.settings.columns)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isNaN(next)) {
                    return;
                  }
                  applyDashboardUpdate((current) => ({
                    ...current,
                    settings: {
                      ...current.settings,
                      columns: Math.max(1, Math.min(next, 6)),
                    },
                  }));
                }}
              >
                {[1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    {value} columns
                  </option>
                ))}
              </Select>
              <Select
                value={draft.settings.tileSize}
                onChange={(event) => {
                  const value = event.target.value as LinkTileSizeId;
                  applyDashboardUpdate((current) => ({
                    ...current,
                    settings: {
                      ...current.settings,
                      tileSize: value,
                    },
                  }));
                }}
              >
                <option value="sm">Small tiles</option>
                <option value="md">Medium tiles</option>
                <option value="lg">Large tiles</option>
              </Select>
              <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={draft.settings.defaultOpenInNewTab}
                  onChange={(event) =>
                    applyDashboardUpdate((current) => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        defaultOpenInNewTab: event.target.checked,
                      },
                    }))
                  }
                />
                Open links in new tab by default
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={newGroupTitle}
                onChange={(event) => setNewGroupTitle(event.target.value)}
                placeholder="New group name"
                className="max-w-xs"
              />
              <Button type="button" variant="outline" onClick={addGroup}>
                <Plus className="mr-1 h-4 w-4" />
                Add Group
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!isDirty}
                onClick={cancelEditMode}
              >
                Reset
              </Button>
              {saveMutation.isError && (
                <span className="text-xs text-rose-400">
                  Failed to save. Check URL fields and try again.
                </span>
              )}
            </div>
          </div>
        )}

        <div className={cn('grid gap-4', editMode ? 'xl:grid-cols-[2fr_1fr]' : '')}>
          <div className="space-y-4">
            {draft.groups.map((group, groupIndex) => (
              <Card
                key={group.id}
                className={cn(groupToneClassName[group.color])}
                onDragOver={editMode ? (event) => event.preventDefault() : undefined}
                onDrop={editMode ? handleGroupDrop(group.id) : undefined}
              >
                <CardHeader className="pb-3">
                  {editMode ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        draggable={editMode}
                        onDragStart={createDragStartHandler({ type: 'group', groupId: group.id })}
                        onDragEnd={clearDrag}
                        className="flex cursor-grab items-center justify-center rounded border border-border/60 p-1 text-muted-foreground"
                      >
                        <GripVertical className="h-4 w-4" />
                      </span>
                      <Input
                        value={group.title}
                        onChange={(event) =>
                          applyDashboardUpdate((current) => ({
                            ...current,
                            groups: current.groups.map((entry, index) =>
                              index === groupIndex
                                ? { ...entry, title: event.target.value }
                                : entry,
                            ),
                          }))
                        }
                        className="min-w-[200px] flex-1"
                      />
                      <Select
                        value={group.color}
                        onChange={(event) => {
                          const nextColor = event.target.value as LinkGroupColorId;
                          applyDashboardUpdate((current) => ({
                            ...current,
                            groups: current.groups.map((entry, index) =>
                              index === groupIndex ? { ...entry, color: nextColor } : entry,
                            ),
                          }));
                        }}
                        className="w-[140px]"
                      >
                        {groupColors.map((color) => (
                          <option key={color} value={color}>
                            {capitalize(color)}
                          </option>
                        ))}
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          applyDashboardUpdate((current) => ({
                            ...current,
                            groups: current.groups.map((entry, index) =>
                              index === groupIndex
                                ? { ...entry, collapsed: !entry.collapsed }
                                : entry,
                            ),
                          }))
                        }
                      >
                        {group.collapsed ? 'Expand' : 'Collapse'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={groupIndex === 0}
                        onClick={() => moveGroup(groupIndex, -1)}
                        aria-label="Move group up"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={groupIndex >= draft.groups.length - 1}
                        onClick={() => moveGroup(groupIndex, 1)}
                        aria-label="Move group down"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openCreateTileEditor(group.id)}
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        Add Tile
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openCreateWidget(group.id)}
                      >
                        <Activity className="mr-1 h-4 w-4" />
                        Add Widget
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={draft.groups.length <= 1}
                        onClick={() => removeGroup(groupIndex)}
                        aria-label="Delete group"
                      >
                        <Trash2 className="h-4 w-4 text-rose-400" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-base">{group.title}</CardTitle>
                      <span className="text-xs text-muted-foreground">
                        {(group.tiles ?? []).length} tiles · {(group.widgets ?? []).length} widgets
                      </span>
                    </div>
                  )}
                </CardHeader>
                {(!editMode || !group.collapsed) && (
                  <CardContent className="space-y-3">
                    {group.tiles.length === 0 && (group.widgets ?? []).length === 0 && (
                      <div className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
                        {editMode
                          ? 'No tiles or widgets yet. Add custom links, live widgets, or use suggestions.'
                          : 'No tiles or widgets configured. Enter edit mode to customize this group.'}
                      </div>
                    )}
                    <div
                      className="grid gap-3"
                      style={{
                        gridTemplateColumns: `repeat(${Math.max(1, Math.min(draft.settings.columns, 6))}, minmax(0, 1fr))`,
                      }}
                    >
                      {group.tiles.map((tile, tileIndex) => (
                        <div
                          key={tile.id}
                          draggable={editMode}
                          onDragStart={createDragStartHandler({
                            type: 'tile',
                            groupId: group.id,
                            tileId: tile.id,
                          })}
                          onDragOver={editMode ? (event) => event.preventDefault() : undefined}
                          onDrop={editMode ? handleTileDrop(group.id, tile.id) : undefined}
                          onDragEnd={clearDrag}
                          className={cn(
                            'rounded-lg border border-border/60 bg-background/60 shadow-sm',
                            tileSizeClassNames[draft.settings.tileSize],
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <a
                              href={tile.url}
                              target={tile.openInNewTab ? '_blank' : '_self'}
                              rel={tile.openInNewTab ? 'noreferrer' : undefined}
                              className="min-w-0 flex-1 no-underline"
                            >
                              <div className="flex items-center gap-2">
                                <IconSwatch icon={tile.icon} />
                                <div className="truncate font-medium">{tile.title}</div>
                              </div>
                              <div className="mt-1 truncate text-xs text-muted-foreground">
                                {readHost(tile.url)}
                              </div>
                              {tile.description && draft.settings.tileSize !== 'sm' && (
                                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                  {tile.description}
                                </div>
                              )}
                            </a>
                            {editMode && (
                              <div className="flex shrink-0 flex-col gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 px-0"
                                  onClick={() => openEditTileEditor(group.id, tile)}
                                  aria-label="Edit tile"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 px-0"
                                  disabled={tileIndex === 0}
                                  onClick={() => moveTile(group.id, tile.id, -1)}
                                  aria-label="Move tile up"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 px-0"
                                  disabled={tileIndex >= group.tiles.length - 1}
                                  onClick={() => moveTile(group.id, tile.id, 1)}
                                  aria-label="Move tile down"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 px-0"
                                  onClick={() => removeTile(group.id, tile.id)}
                                  aria-label="Delete tile"
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    {editMode && (
                      <div
                        className="h-4"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={handleTileDrop(group.id)}
                      />
                    )}

                    {(group.widgets ?? []).length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Live Widgets
                        </div>
                        <div
                          className="grid gap-3"
                          style={{
                            gridTemplateColumns: `repeat(${Math.max(1, Math.min(draft.settings.columns, 6))}, minmax(0, 1fr))`,
                          }}
                        >
                          {(group.widgets ?? []).map((widget, widgetIndex) => (
                            <div
                              key={widget.id}
                              className={cn(
                                'rounded-lg border border-border/60 bg-background/60 shadow-sm',
                                tileSizeClassNames[draft.settings.tileSize],
                                widget.size === 'tall' ? 'min-h-[16rem]' : '',
                              )}
                              style={widgetGridStyle(widget.size, draft.settings.columns)}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1 space-y-2">
                                  <div className="flex items-center gap-2">
                                    <IconSwatch
                                      icon={
                                        widget.kind === 'host-metric'
                                          ? 'activity'
                                          : widget.kind === 'homelab-metric'
                                            ? 'chart'
                                            : widget.kind === 'host-terminal'
                                              ? 'terminal'
                                              : widget.kind === 'home-summary-card'
                                                ? 'chart'
                                                : widget.kind === 'home-whats-broken'
                                                  ? 'shield'
                                                  : widget.kind === 'home-recent-events'
                                                    ? 'activity'
                                                    : widget.kind === 'home-top-consumers'
                                                      ? 'server'
                                                      : widget.kind === 'dashboard-agent-highlights'
                                                        ? 'bot'
                                                        : 'bot'
                                      }
                                    />
                                    <div className="truncate text-sm font-medium">
                                      {widget.title}
                                    </div>
                                  </div>
                                  {widget.description && (
                                    <div className="text-xs text-muted-foreground">
                                      {widget.description}
                                    </div>
                                  )}
                                  {widget.kind === 'host-metric' && (
                                    <HostMetricLiveWidget widget={widget} />
                                  )}
                                  {widget.kind === 'homelab-metric' && (
                                    <HomelabMetricLiveWidget widget={widget} />
                                  )}
                                  {widget.kind === 'home-summary-card' && (
                                    <HomelabMetricLiveWidget widget={widget} />
                                  )}
                                  {widget.kind === 'home-whats-broken' && <HomeWhatsBrokenWidget />}
                                  {widget.kind === 'home-recent-events' && (
                                    <HomeRecentEventsWidget />
                                  )}
                                  {widget.kind === 'home-top-consumers' && (
                                    <HomeTopConsumersWidget />
                                  )}
                                  {widget.kind === 'dashboard-agent-highlights' && (
                                    <DashboardAgentHighlightsWidgetCard widget={widget} />
                                  )}
                                  {widget.kind === 'host-terminal' && (
                                    <HostTerminalWidgetCard widget={widget} />
                                  )}
                                  {widget.kind === 'ai-chat' && <AiAskWidget widget={widget} />}
                                </div>
                                {editMode && (
                                  <div className="flex shrink-0 flex-col gap-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 px-0"
                                      onClick={() => openEditWidget(group.id, widget)}
                                      aria-label="Edit widget"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 px-0"
                                      disabled={widgetIndex === 0}
                                      onClick={() => moveWidget(group.id, widget.id, -1)}
                                      aria-label="Move widget up"
                                    >
                                      <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 px-0"
                                      disabled={widgetIndex >= (group.widgets ?? []).length - 1}
                                      onClick={() => moveWidget(group.id, widget.id, 1)}
                                      aria-label="Move widget down"
                                    >
                                      <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 px-0"
                                      onClick={() => removeWidget(group.id, widget.id)}
                                      aria-label="Delete widget"
                                    >
                                      <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>

          {editMode && (
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Suggested Links</CardTitle>
                <CardDescription>
                  Suggestions inferred from discovered services, instances, and known homelab apps.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {suggestionsQuery.isLoading && (
                  <div className="text-xs text-muted-foreground">
                    Scanning discovered services...
                  </div>
                )}
                {suggestionsQuery.isError && (
                  <div className="text-xs text-rose-400">Could not load suggestions.</div>
                )}
                {!suggestionsQuery.isLoading && suggestions.length === 0 && (
                  <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                    No suggestions yet. Run service discovery/sync and refresh this page.
                  </div>
                )}
                {suggestions.slice(0, 40).map((suggestion) => {
                  const added = existingUrls.has(normalizeUrlKey(suggestion.url));
                  return (
                    <div
                      key={suggestion.id}
                      className="rounded-md border border-border/60 bg-background/60 p-3"
                    >
                      <div className="flex items-start gap-2">
                        <IconSwatch icon={suggestion.icon} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate text-sm font-medium">{suggestion.title}</div>
                            <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                              {suggestion.confidence}%
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {suggestion.url}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {suggestion.description}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {suggestion.groupHint} · {suggestion.serviceName}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={added ? 'secondary' : 'outline'}
                          disabled={added}
                          onClick={() => addSuggestion(suggestion)}
                        >
                          {added ? 'Added' : 'Add Tile'}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" asChild>
                          <a href={suggestion.url} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog
        open={editMode && Boolean(tileEditor)}
        onOpenChange={(open) => {
          if (!open) {
            setTileEditor(null);
            setTileEditorError(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          {tileEditor && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-lg font-semibold">
                    {tileEditor.mode === 'create' ? 'Create Link Tile' : 'Edit Link Tile'}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Configure title, URL, icon, and destination group.
                  </div>
                </div>
                <DialogClose asChild>
                  <Button type="button" variant="outline" size="sm">
                    Close
                  </Button>
                </DialogClose>
              </div>

              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveTileEditor();
                }}
              >
                <Input
                  value={tileEditor.values.title}
                  onChange={(event) =>
                    setTileEditor((current) =>
                      current
                        ? {
                            ...current,
                            values: {
                              ...current.values,
                              title: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                  placeholder="Tile title"
                />
                <Input
                  value={tileEditor.values.url}
                  onChange={(event) =>
                    setTileEditor((current) =>
                      current
                        ? {
                            ...current,
                            values: {
                              ...current.values,
                              url: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                  placeholder="https://service.example.local"
                />
                <Textarea
                  value={tileEditor.values.description}
                  onChange={(event) =>
                    setTileEditor((current) =>
                      current
                        ? {
                            ...current,
                            values: {
                              ...current.values,
                              description: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                  placeholder="Description (optional)"
                />
                <div className="grid gap-2 md:grid-cols-2">
                  <Select
                    value={tileEditor.values.icon}
                    onChange={(event) =>
                      setTileEditor((current) =>
                        current
                          ? {
                              ...current,
                              values: {
                                ...current.values,
                                icon: event.target.value as KnownLinkIconId,
                              },
                            }
                          : current,
                      )
                    }
                  >
                    {knownIcons.map((icon) => (
                      <option key={icon.id} value={icon.id}>
                        {icon.label}
                      </option>
                    ))}
                  </Select>
                  <Select
                    value={tileEditor.values.targetGroupId}
                    onChange={(event) =>
                      setTileEditor((current) =>
                        current
                          ? {
                              ...current,
                              values: {
                                ...current.values,
                                targetGroupId: event.target.value,
                              },
                            }
                          : current,
                      )
                    }
                  >
                    {draft.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.title}
                      </option>
                    ))}
                  </Select>
                </div>
                <label className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={tileEditor.values.openInNewTab}
                    onChange={(event) =>
                      setTileEditor((current) =>
                        current
                          ? {
                              ...current,
                              values: {
                                ...current.values,
                                openInNewTab: event.target.checked,
                              },
                            }
                          : current,
                      )
                    }
                  />
                  Open this link in new tab
                </label>
                {tileEditorError && <div className="text-xs text-rose-400">{tileEditorError}</div>}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setTileEditor(null)}>
                    Cancel
                  </Button>
                  <Button type="submit">Save Tile</Button>
                </div>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={editMode && Boolean(widgetEditor)}
        onOpenChange={(open) => {
          if (!open) {
            setWidgetEditor(null);
            setWidgetEditorError(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          {widgetEditor && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-lg font-semibold">
                    {widgetEditor.mode === 'create' ? 'Create Live Widget' : 'Edit Live Widget'}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Add host metrics, homelab-wide DB metrics, SSH terminal launchers, or AI
                    question widgets.
                  </div>
                </div>
                <DialogClose asChild>
                  <Button type="button" variant="outline" size="sm">
                    Close
                  </Button>
                </DialogClose>
              </div>

              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveWidgetEditor();
                }}
              >
                <Select
                  value={widgetEditor.values.kind}
                  onChange={(event) =>
                    setWidgetEditor((current) =>
                      current
                        ? {
                            ...current,
                            values: {
                              ...current.values,
                              kind: event.target.value as WidgetEditorKind,
                            },
                          }
                        : current,
                    )
                  }
                >
                  <option value="host-metric">Host Metric Widget</option>
                  <option value="homelab-metric">Homelab Metric Widget</option>
                  <option value="host-terminal">Host Terminal Widget</option>
                  <option value="home-whats-broken">What&apos;s Broken Widget</option>
                  <option value="home-recent-events">Recent Events Widget</option>
                  <option value="home-top-consumers">Top Consumers Widget</option>
                  <option value="dashboard-agent-highlights">
                    Dashboard Agent Highlights Widget
                  </option>
                  <option value="ai-chat">AI Question Widget</option>
                </Select>
                {widgetEditor.values.kind !== 'ai-chat' && (
                  <>
                    <Input
                      value={widgetEditor.values.title}
                      onChange={(event) =>
                        setWidgetEditor((current) =>
                          current
                            ? {
                                ...current,
                                values: {
                                  ...current.values,
                                  title: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      placeholder="Widget title"
                    />
                    <Textarea
                      value={widgetEditor.values.description}
                      onChange={(event) =>
                        setWidgetEditor((current) =>
                          current
                            ? {
                                ...current,
                                values: {
                                  ...current.values,
                                  description: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      placeholder="Description (optional)"
                    />
                  </>
                )}
                <Select
                  value={widgetEditor.values.size}
                  onChange={(event) =>
                    setWidgetEditor((current) =>
                      current
                        ? {
                            ...current,
                            values: {
                              ...current.values,
                              size: event.target.value as LinkWidgetSizeId,
                            },
                          }
                        : current,
                    )
                  }
                >
                  {widgetSizeLabels.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
                {widgetEditor.values.kind === 'host-metric' ||
                widgetEditor.values.kind === 'host-terminal' ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    <Select
                      value={widgetEditor.values.hostId}
                      onChange={(event) =>
                        setWidgetEditor((current) =>
                          current
                            ? {
                                ...current,
                                values: {
                                  ...current.values,
                                  hostId: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    >
                      <option value="">Select host</option>
                      {hosts.map((host) => (
                        <option key={String(host.id)} value={String(host.id)}>
                          {String(host.hostname ?? host.id)}
                        </option>
                      ))}
                    </Select>
                    {widgetEditor.values.kind === 'host-metric' ? (
                      <Select
                        value={widgetEditor.values.metric}
                        onChange={(event) =>
                          setWidgetEditor((current) =>
                            current
                              ? {
                                  ...current,
                                  values: {
                                    ...current.values,
                                    metric: event.target.value as LinkWidgetMetricId,
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="cpu">CPU</option>
                        <option value="mem">Memory</option>
                        <option value="disk">Disk</option>
                        <option value="network">Network Throughput</option>
                        <option value="diskIo">Disk I/O Throughput</option>
                      </Select>
                    ) : (
                      <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                        Terminal widget opens an SSH gateway session for the selected host.
                      </div>
                    )}
                  </div>
                ) : widgetEditor.values.kind === 'homelab-metric' ? (
                  <Select
                    value={widgetEditor.values.homelabMetric}
                    onChange={(event) =>
                      setWidgetEditor((current) =>
                        current
                          ? {
                              ...current,
                              values: {
                                ...current.values,
                                homelabMetric: event.target.value as HomelabMetricId,
                              },
                            }
                          : current,
                      )
                    }
                  >
                    <option value="hostsOnline">Hosts Online</option>
                    <option value="hostsOffline">Hosts Offline</option>
                    <option value="activeAlerts">Active Alerts</option>
                    <option value="failingChecks">Failing Monitors</option>
                  </Select>
                ) : widgetEditor.values.kind === 'ai-chat' ? (
                  <div className="space-y-2">
                    <Textarea
                      value={widgetEditor.values.aiQuestion}
                      onChange={(event) =>
                        setWidgetEditor((current) =>
                          current
                            ? {
                                ...current,
                                values: {
                                  ...current.values,
                                  aiQuestion: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      placeholder="Question to ask AI"
                    />
                    <Input
                      type="number"
                      min={30}
                      max={86400}
                      step={1}
                      value={widgetEditor.values.aiRefreshIntervalSec}
                      onChange={(event) =>
                        setWidgetEditor((current) =>
                          current
                            ? {
                                ...current,
                                values: {
                                  ...current.values,
                                  aiRefreshIntervalSec: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                      placeholder="Refresh interval in seconds (optional)"
                    />
                    <div className="text-xs text-muted-foreground">
                      Leave interval blank to disable scheduling. Minimum scheduled interval is 30
                      seconds.
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                    This widget uses homelab-wide data from the control plane summary feed.
                  </div>
                )}
                <Select
                  value={widgetEditor.values.targetGroupId}
                  onChange={(event) =>
                    setWidgetEditor((current) =>
                      current
                        ? {
                            ...current,
                            values: {
                              ...current.values,
                              targetGroupId: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                >
                  {draft.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.title}
                    </option>
                  ))}
                </Select>
                {widgetEditorError && (
                  <div className="text-xs text-rose-400">{widgetEditorError}</div>
                )}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setWidgetEditor(null)}>
                    Cancel
                  </Button>
                  <Button type="submit">Save Widget</Button>
                </div>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Renders the icon swatch view.
 */
function IconSwatch({ icon }: { icon: KnownLinkIconId }) {
  const Icon = iconById[icon] ?? Globe;
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/70">
      <Icon className="h-4 w-4 text-muted-foreground" />
    </span>
  );
}

/**
 * Renders the host metric live widget view.
 */
function HostMetricLiveWidget({ widget }: { widget: HostMetricWidget }) {
  const query = useQuery({
    queryKey: ['link-widget-host', widget.hostId],
    queryFn: () => apiFetch<Record<string, unknown>>(`/api/hosts/${widget.hostId}`),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="rounded border border-border/50 p-2 text-xs text-muted-foreground">
        Loading host data...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-rose-500/40 p-2 text-xs text-rose-400">
        Host data unavailable.
      </div>
    );
  }

  const facts = (Array.isArray(query.data.facts) ? query.data.facts : []) as HostFact[];
  const points = buildMetricSeries(facts, widget.metric);
  const latestPoint = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div className="rounded border border-border/50 bg-background/40 p-2">
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="truncate">{widget.hostName}</span>
        <span>{metricLabel(widget.metric)}</span>
      </div>
      <div className={`mt-1 text-sm font-semibold ${metricToneClass(widget.metric)}`}>
        {latestPoint ? formatMetricValue(widget.metric, latestPoint.value) : '-'}
      </div>
      <MiniSparkline
        points={points}
        toneClass={metricToneClass(widget.metric)}
        metric={widget.metric}
      />
      <div className="mt-1 text-[10px] text-muted-foreground">{formatMetricRange(points)}</div>
    </div>
  );
}

/**
 * Renders the homelab metric live widget view.
 */
function HomelabMetricLiveWidget({
  widget,
}: {
  widget: HomelabMetricWidget | Extract<LinkWidget, { kind: 'home-summary-card' }>;
}) {
  const query = useQuery({
    queryKey: ['home-summary'],
    queryFn: () => apiFetch<HomeSummaryResponse>('/api/home/summary'),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="rounded border border-border/50 p-2 text-xs text-muted-foreground">
        Loading homelab metric...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-rose-500/40 p-2 text-xs text-rose-400">
        Homelab metric unavailable.
      </div>
    );
  }

  const value = query.data.cards[widget.metric] ?? 0;
  const destination = homelabMetricDestination(widget.metric);

  return (
    <Link
      to={destination.to}
      className="block rounded border border-border/50 bg-background/40 p-2 transition hover:border-border hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={destination.hint}
      aria-label={`${homelabMetricLabel(widget.metric)}: ${value}. ${destination.hint}`}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {homelabMetricLabel(widget.metric)}
      </div>
      <div className={`mt-1 text-2xl font-semibold ${homelabMetricToneClass(widget.metric)}`}>
        {value}
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">{destination.hint}</div>
    </Link>
  );
}

/**
 * Renders the home whats broken widget view.
 */
function HomeWhatsBrokenWidget() {
  const query = useQuery({
    queryKey: ['home-summary'],
    queryFn: () => apiFetch<HomeSummaryResponse>('/api/home/summary'),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="rounded border border-border/50 p-2 text-xs text-muted-foreground">
        Loading issues...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-rose-500/40 p-2 text-xs text-rose-400">
        Issue summary unavailable.
      </div>
    );
  }

  const alerts = query.data.whatsBroken.alerts;
  const downChecks = query.data.whatsBroken.downChecks;
  const offlineHosts = query.data.whatsBroken.offlineHosts;
  const items = [
    ...alerts.map((item) => String(item.message ?? item.name ?? 'Active alert')),
    ...downChecks.map((item) => String(item.message ?? item.name ?? 'Failing monitor')),
    ...offlineHosts.map((item) => String(item.hostname ?? item.name ?? 'Offline host')),
  ].slice(0, 6);

  return (
    <div className="space-y-2 rounded border border-border/50 bg-background/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <Link
          to="/alerts?status=active"
          className="rounded border border-border/50 bg-background/70 px-2 py-1 transition hover:border-border hover:bg-background"
        >
          {alerts.length} alerts
        </Link>
        <Link
          to="/monitors?status=failing"
          className="rounded border border-border/50 bg-background/70 px-2 py-1 transition hover:border-border hover:bg-background"
        >
          {downChecks.length} down monitors
        </Link>
        <Link
          to="/hosts?status=offline"
          className="rounded border border-border/50 bg-background/70 px-2 py-1 transition hover:border-border hover:bg-background"
        >
          {offlineHosts.length} offline hosts
        </Link>
      </div>
      <div className="space-y-1">
        {items.length === 0 && <div className="text-muted-foreground">No current issues.</div>}
        {items.map((item, index) => (
          <div
            key={`${item}-${index}`}
            className="line-clamp-1 rounded border border-border/50 bg-background/70 px-2 py-1"
          >
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders the home recent events widget view.
 */
function HomeRecentEventsWidget() {
  const query = useQuery({
    queryKey: ['home-summary'],
    queryFn: () => apiFetch<HomeSummaryResponse>('/api/home/summary'),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="rounded border border-border/50 p-2 text-xs text-muted-foreground">
        Loading events...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-rose-500/40 p-2 text-xs text-rose-400">
        Event feed unavailable.
      </div>
    );
  }

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto rounded border border-border/50 bg-background/40 p-2 text-xs">
      {query.data.recentEvents.slice(0, 10).map((event, index) => (
        <div
          key={`${event.id ?? index}`}
          className="rounded border border-border/50 bg-background/70 px-2 py-1"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <span className={eventSeverityTone(event.severity)}>●</span>
              <span className="font-medium">{String(event.type ?? 'event')}</span>
            </div>
            <span
              className="text-[10px] text-muted-foreground"
              title={formatTimestamp(event.createdAt)}
            >
              {formatTimeAgo(event.createdAt)}
            </span>
          </div>
          <div className="line-clamp-2 text-muted-foreground">{String(event.message ?? '')}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the home top consumers widget view.
 */
function HomeTopConsumersWidget() {
  const query = useQuery({
    queryKey: ['home-summary'],
    queryFn: () => apiFetch<HomeSummaryResponse>('/api/home/summary'),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="rounded border border-border/50 p-2 text-xs text-muted-foreground">
        Loading host usage...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-rose-500/40 p-2 text-xs text-rose-400">
        Host usage unavailable.
      </div>
    );
  }

  return (
    <div className="space-y-1 rounded border border-border/50 bg-background/40 p-2 text-xs">
      {query.data.topConsumers.slice(0, 6).map((host, index) => (
        <div
          key={`${host.id ?? index}`}
          className="rounded border border-border/50 bg-background/70 px-2 py-1"
        >
          <div className="font-medium">{String(host.hostname ?? 'unknown')}</div>
          <div className="text-muted-foreground">
            CPU {Number(host.cpuPct ?? 0).toFixed(1)}% · MEM {Number(host.memPct ?? 0).toFixed(1)}%
            · DISK {Number(host.diskPct ?? 0).toFixed(1)}%
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the host terminal widget card view.
 */
function HostTerminalWidgetCard({ widget }: { widget: HostTerminalWidget }) {
  return (
    <div className="rounded border border-border/50 bg-background/40 p-2">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Target: {widget.hostName}
      </div>
      <HostTerminalDialog
        hostId={widget.hostId}
        hostName={widget.hostName}
        triggerLabel="Open SSH"
        triggerVariant="secondary"
        triggerSize="sm"
      />
    </div>
  );
}

/**
 * Renders the dashboard agent highlights widget card view.
 */
function DashboardAgentHighlightsWidgetCard({
  widget,
}: {
  widget: Extract<LinkWidget, { kind: 'dashboard-agent-highlights' }>;
}) {
  const query = useQuery({
    queryKey: ['dashboard-agent-widget-highlights', widget.id],
    queryFn: () => apiFetch<DashboardAgentHighlightsResponse>('/api/dashboard-agent/highlights'),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="rounded border border-border/50 p-2 text-xs text-muted-foreground">
        Loading highlights...
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-rose-500/40 p-2 text-xs text-rose-400">
        Highlights unavailable.
      </div>
    );
  }

  const highlights = query.data.highlights.slice(0, 3);
  return (
    <div className="space-y-2 rounded border border-border/50 bg-background/40 p-2 text-xs">
      {highlights.length === 0 && (
        <div className="text-muted-foreground">
          No highlights yet. Run Dashboard Agent to generate findings.
        </div>
      )}
      {highlights.map((highlight) => (
        <div
          key={highlight.id}
          className="rounded border border-border/50 bg-background/70 px-2 py-1"
        >
          <div className="flex items-center gap-2">
            <span className={dashboardAgentSeverityDot(highlight.severity)}>●</span>
            <span className="line-clamp-1 font-medium">{highlight.title}</span>
          </div>
          <div className="line-clamp-2 text-muted-foreground">{highlight.summary}</div>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-muted-foreground">
          {query.data.generatedAt
            ? `Updated ${formatTimeAgo(query.data.generatedAt)}`
            : 'No completed run yet'}
        </div>
        <Link
          to="/dashboard-agent"
          className="text-[11px] font-medium text-primary hover:underline"
        >
          Open
        </Link>
      </div>
    </div>
  );
}

/**
 * Renders the mini sparkline view.
 */
function MiniSparkline({
  points,
  toneClass,
  metric,
}: {
  points: MetricPoint[];
  toneClass: string;
  metric: LinkWidgetMetricId;
}) {
  if (points.length === 0) {
    return (
      <div className="mt-2 h-12 rounded border border-dashed border-border/50 bg-background/40" />
    );
  }

  const maxIndex = Math.max(points.length - 1, 1);
  const graphHeight = 30;
  const usesPercentScale = isPercentMetric(metric);
  let scaleMax = usesPercentScale ? 100 : 1;
  if (!usesPercentScale) {
    for (const point of points) {
      scaleMax = Math.max(scaleMax, point.value);
    }
  }
  const pointsText = points
    .map((point, index) => {
      const x = (index / maxIndex) * 100;
      const normalized = usesPercentScale
        ? clampPct(point.value) / 100
        : Math.max(0, point.value) / scaleMax;
      const y = graphHeight - normalized * graphHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className={`mt-2 ${toneClass}`}>
      <svg viewBox="0 0 100 30" className="h-12 w-full">
        <line x1="0" y1="15" x2="100" y2="15" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <polyline
          points={pointsText}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/**
 * Renders the ai ask widget view.
 */
function AiAskWidget({ widget }: { widget: Extract<LinkWidget, { kind: 'ai-chat' }> }) {
  const conversationIdRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(false);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const question = widget.question.trim();
  const refreshIntervalSec = normalizeAiRefreshInterval(widget.refreshIntervalSec);

  const runQuestion = useCallback(async () => {
    if (!question || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const token = getToken();
      if (!token) {
        throw new Error('Missing auth token');
      }

      const response = await fetch(`${apiBaseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          message: question,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let output = '';

      // Parse streamed SSE chunks so partial model output can render incrementally.
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          let eventType = 'message';
          let data = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            }
            if (line.startsWith('data:')) {
              data = line.slice(5).trim();
            }
          }

          if (!data) {
            continue;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (eventType === 'token') {
            output += String(parsed.content ?? '');
            setAnswer(output);
          }

          if (eventType === 'done') {
            const nextConversationId = parsed.conversationId;
            if (typeof nextConversationId === 'string') {
              conversationIdRef.current = nextConversationId;
            }
          }
        }
      }

      if (!output.trim()) {
        setAnswer('No assistant output returned for this request.');
      }
      setLastUpdatedAt(new Date().toISOString());
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'AI request failed.';
      setError(message);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [question]);

  useEffect(() => {
    conversationIdRef.current = undefined;
    setAnswer('');
    setLastUpdatedAt(null);
    if (!question) {
      return;
    }
    void runQuestion();
  }, [question, runQuestion]);

  useEffect(() => {
    if (!refreshIntervalSec) {
      return;
    }
    const timer = window.setInterval(() => {
      void runQuestion();
    }, refreshIntervalSec * 1000);

    return () => window.clearInterval(timer);
  }, [refreshIntervalSec, runQuestion]);

  return (
    <div className="space-y-2">
      <div className="rounded border border-border/50 bg-background/40 p-2 text-xs text-muted-foreground">
        {question}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-muted-foreground">
          {refreshIntervalSec
            ? `Auto-refresh every ${refreshIntervalSec}s`
            : 'Auto-refresh disabled'}
          {lastUpdatedAt ? ` · Updated ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void runQuestion()}
        >
          {loading ? 'Updating...' : 'Refresh'}
        </Button>
      </div>
      {error && <div className="text-xs text-rose-400">{error}</div>}
      <div className="max-h-44 overflow-auto rounded border border-border/50 bg-background/40 p-2 text-xs whitespace-pre-wrap">
        {answer || 'Waiting for response...'}
      </div>
    </div>
  );
}

/**
 * Implements clone dashboard.
 */
function cloneDashboard(dashboard: LinksDashboard): LinksDashboard {
  // Deep clone to avoid mutating react-query cache objects directly.
  const cloned = JSON.parse(JSON.stringify(dashboard)) as LinksDashboard;
  for (const group of cloned.groups) {
    if (!Array.isArray(group.widgets)) {
      group.widgets = [];
    }
    for (const widget of group.widgets) {
      if (!widget.size) {
        widget.size = 'normal';
      }
      if (widget.kind === 'ai-chat') {
        const question = widget.question?.trim() || 'What should I look at first right now?';
        widget.question = question;
        widget.refreshIntervalSec = normalizeAiRefreshInterval(widget.refreshIntervalSec);
        widget.title = makeAiWidgetTitle(question);
        widget.description = buildAiWidgetDescription(widget.refreshIntervalSec);
      }
    }
  }
  return cloned;
}

/**
 * Implements widget grid style.
 */
function widgetGridStyle(size: LinkWidgetSizeId, columns: number) {
  const safeColumns = Math.max(1, Math.min(columns, 6));
  const colSpan = size === 'wide' ? Math.min(2, safeColumns) : 1;
  const rowSpan = size === 'tall' ? 2 : 1;
  return {
    gridColumn: `span ${colSpan} / span ${colSpan}`,
    gridRow: `span ${rowSpan} / span ${rowSpan}`,
  } as const;
}

/**
 * Implements the move in array workflow for this file.
 */
function moveInArray<T>(values: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) {
    return values;
  }

  const next = [...values];
  const [value] = next.splice(from, 1);
  if (value === undefined) {
    return values;
  }
  next.splice(to, 0, value);
  return next;
}

/**
 * Implements normalize url.
 */
function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Implements normalize url key.
 */
function normalizeUrlKey(value: string) {
  const normalized = normalizeUrl(value);
  return normalized ? normalized.toLowerCase() : value.trim().toLowerCase();
}

/**
 * Implements fingerprint pending suggestions.
 */
function fingerprintPendingSuggestions(suggestions: LinkSuggestion[]) {
  if (suggestions.length === 0) {
    return '';
  }
  const canonical = suggestions
    .map((suggestion) => normalizeUrlKey(suggestion.url))
    .sort()
    .join('\n');
  return hashText(canonical);
}

/**
 * Checks whether hash text.
 */
function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Implements validate tile form.
 */
function validateTileForm(values: TileFormValues) {
  if (values.title.trim().length === 0) {
    return 'Title is required.';
  }
  if (!normalizeUrl(values.url)) {
    return 'URL must be a valid http:// or https:// address.';
  }
  return null;
}

/**
 * Implements validate widget form.
 */
function validateWidgetForm(values: WidgetFormValues, hostsById: Map<string, string>) {
  if (values.kind !== 'ai-chat' && values.title.trim().length === 0) {
    return 'Widget title is required.';
  }

  if (values.kind === 'ai-chat') {
    if (values.aiQuestion.trim().length === 0) {
      return 'AI question is required.';
    }
    const trimmed = values.aiRefreshIntervalSec.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return 'Refresh interval must be a whole number of seconds.';
      }
      if (parsed < 30 || parsed > 86_400) {
        return 'Refresh interval must be between 30 and 86400 seconds.';
      }
    }
  }

  if (values.kind === 'homelab-metric' && !values.homelabMetric) {
    return 'Select a homelab metric.';
  }

  if (values.kind === 'host-metric' || values.kind === 'host-terminal') {
    if (!values.hostId.trim()) {
      return 'Select a host for the widget.';
    }
    if (values.kind === 'host-metric' && !values.metric) {
      return 'Select a metric.';
    }
    if (hostsById.size > 0 && !hostsById.has(values.hostId)) {
      return 'Selected host is not available.';
    }
  }

  return null;
}

/**
 * Implements metric label.
 */
function metricLabel(metric: LinkWidgetMetricId) {
  if (metric === 'cpu') {
    return 'CPU';
  }
  if (metric === 'mem') {
    return 'Memory';
  }
  if (metric === 'disk') {
    return 'Disk';
  }
  if (metric === 'network') {
    return 'Network';
  }
  return 'Disk I/O';
}

/**
 * Implements homelab metric label.
 */
function homelabMetricLabel(metric: HomelabMetricId) {
  if (metric === 'hostsOnline') {
    return 'Hosts Online';
  }
  if (metric === 'hostsOffline') {
    return 'Hosts Offline';
  }
  if (metric === 'activeAlerts') {
    return 'Active Alerts';
  }
  return 'Failing Monitors';
}

/**
 * Implements dashboard agent severity dot.
 */
function dashboardAgentSeverityDot(severity: 'info' | 'warn' | 'critical') {
  if (severity === 'critical') {
    return 'text-rose-400';
  }
  if (severity === 'warn') {
    return 'text-amber-400';
  }
  return 'text-sky-400';
}

/**
 * Implements homelab metric tone class.
 */
function homelabMetricToneClass(metric: HomelabMetricId) {
  if (metric === 'hostsOnline') {
    return 'text-emerald-500';
  }
  if (metric === 'hostsOffline') {
    return 'text-rose-500';
  }
  if (metric === 'activeAlerts') {
    return 'text-amber-500';
  }
  return 'text-rose-500';
}

/**
 * Implements homelab metric destination.
 */
function homelabMetricDestination(metric: HomelabMetricId): { to: string; hint: string } {
  if (metric === 'hostsOnline') {
    return {
      to: '/hosts?status=online',
      hint: 'Click to view online hosts.',
    };
  }
  if (metric === 'hostsOffline') {
    return {
      to: '/hosts?status=offline',
      hint: 'Click to view offline hosts.',
    };
  }
  if (metric === 'activeAlerts') {
    return {
      to: '/alerts?status=active',
      hint: 'Click to view active alerts.',
    };
  }
  return {
    to: '/monitors?status=failing',
    hint: 'Click to view failing monitors.',
  };
}

/**
 * Implements event severity tone.
 */
function eventSeverityTone(severity: string | undefined) {
  const normalized = String(severity ?? 'INFO').toUpperCase();
  if (normalized === 'ERROR' || normalized === 'CRIT') {
    return 'text-rose-500';
  }
  if (normalized === 'WARN' || normalized === 'WARNING') {
    return 'text-amber-500';
  }
  return 'text-emerald-500';
}

/**
 * Parses ai refresh interval.
 */
function parseAiRefreshInterval(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return null;
  }
  if (parsed < 30 || parsed > 86_400) {
    return null;
  }
  return parsed;
}

/**
 * Implements normalize ai refresh interval.
 */
function normalizeAiRefreshInterval(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  if (value < 30 || value > 86_400) {
    return null;
  }
  return value;
}

/**
 * Implements make ai widget title.
 */
function makeAiWidgetTitle(question: string) {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return 'AI Question';
  }
  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

/**
 * Builds ai widget description.
 */
function buildAiWidgetDescription(refreshIntervalSec: number | null) {
  if (!refreshIntervalSec) {
    return 'Manual refresh only.';
  }
  return `Refreshes every ${refreshIntervalSec}s.`;
}

/**
 * Implements metric tone class.
 */
function metricToneClass(metric: LinkWidgetMetricId) {
  if (metric === 'cpu') {
    return 'text-red-500';
  }
  if (metric === 'mem') {
    return 'text-amber-500';
  }
  if (metric === 'disk') {
    return 'text-emerald-500';
  }
  if (metric === 'network') {
    return 'text-cyan-500';
  }
  return 'text-sky-500';
}

/**
 * Builds metric series.
 */
function buildMetricSeries(facts: HostFact[], metric: LinkWidgetMetricId) {
  if (metric === 'network') {
    return buildNetworkThroughputSeries(facts);
  }

  if (metric === 'diskIo') {
    return buildDiskIoThroughputSeries(facts);
  }

  const points: MetricPoint[] = [];

  for (const fact of facts) {
    const createdAt = fact?.createdAt ? new Date(fact.createdAt).getTime() : NaN;
    const value = metricValueFromSnapshot(fact?.snapshot, metric);
    if (!Number.isFinite(createdAt) || value === null) {
      continue;
    }
    points.push({ at: createdAt, value: clampPct(value) });
  }

  points.sort((a, b) => a.at - b.at);
  return points;
}

/**
 * Implements metric value from snapshot.
 */
function metricValueFromSnapshot(snapshot: unknown, metric: 'cpu' | 'mem' | 'disk') {
  const source = toRecord(snapshot);
  if (!source) {
    return null;
  }

  if (metric === 'cpu') {
    return (
      readNumber(source, ['cpu', 'usage']) ??
      readNumber(source, ['cpu', 'usagePct']) ??
      /**
       * Handles read number.
       */
      readNumber(source, ['cpuPct'])
    );
  }

  if (metric === 'mem') {
    return (
      readNumber(source, ['memory', 'usagePct']) ??
      readNumber(source, ['memPct']) ??
      /**
       * Handles read number.
       */
      readNumber(source, ['memory', 'usage'])
    );
  }

  return (
    readNumber(source, ['storage', 'usagePct']) ??
    readNumber(source, ['diskPct']) ??
    /**
     * Handles read number.
     */
    readNumber(source, ['disk', 'usagePct'])
  );
}

/**
 * Builds network throughput series.
 */
function buildNetworkThroughputSeries(facts: HostFact[]) {
  const samples = facts
    .map((fact) => {
      const at = fact?.createdAt ? new Date(fact.createdAt).getTime() : NaN;
      const counters = readNetworkTotalCounters(fact?.snapshot);
      return {
        at,
        rxBytes: counters?.rxBytes ?? null,
        txBytes: counters?.txBytes ?? null,
      };
    })
    .filter(
      (
        sample,
      ): sample is {
        at: number;
        rxBytes: number;
        txBytes: number;
      } => Number.isFinite(sample.at) && sample.rxBytes !== null && sample.txBytes !== null,
    )
    .sort((a, b) => a.at - b.at);

  const points: MetricPoint[] = [];
  let previous: { at: number; rxBytes: number; txBytes: number } | null = null;
  for (const sample of samples) {
    if (!previous || sample.at <= previous.at) {
      previous = sample;
      continue;
    }

    const deltaSec = (sample.at - previous.at) / 1000;
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
      previous = sample;
      continue;
    }

    const rxRate = Math.max(0, sample.rxBytes - previous.rxBytes) / deltaSec;
    const txRate = Math.max(0, sample.txBytes - previous.txBytes) / deltaSec;
    if (Number.isFinite(rxRate) && Number.isFinite(txRate)) {
      points.push({
        at: sample.at,
        value: rxRate + txRate,
      });
    }

    previous = sample;
  }

  return points;
}

/**
 * Builds disk io throughput series.
 */
function buildDiskIoThroughputSeries(facts: HostFact[]) {
  const samples = facts
    .map((fact) => {
      const at = fact?.createdAt ? new Date(fact.createdAt).getTime() : NaN;
      const counters = readDiskIoCounters(fact?.snapshot);
      return {
        at,
        readBytes: counters?.readBytes ?? null,
        writeBytes: counters?.writeBytes ?? null,
      };
    })
    .filter(
      (
        sample,
      ): sample is {
        at: number;
        readBytes: number;
        writeBytes: number;
      } => Number.isFinite(sample.at) && sample.readBytes !== null && sample.writeBytes !== null,
    )
    .sort((a, b) => a.at - b.at);

  const points: MetricPoint[] = [];
  let previous: { at: number; readBytes: number; writeBytes: number } | null = null;
  for (const sample of samples) {
    if (!previous || sample.at <= previous.at) {
      previous = sample;
      continue;
    }

    const deltaSec = (sample.at - previous.at) / 1000;
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
      previous = sample;
      continue;
    }

    const readRate = Math.max(0, sample.readBytes - previous.readBytes) / deltaSec;
    const writeRate = Math.max(0, sample.writeBytes - previous.writeBytes) / deltaSec;
    if (Number.isFinite(readRate) && Number.isFinite(writeRate)) {
      points.push({
        at: sample.at,
        value: readRate + writeRate,
      });
    }

    previous = sample;
  }

  return points;
}

/**
 * Implements read network total counters.
 */
function readNetworkTotalCounters(snapshot: unknown) {
  const source = toRecord(snapshot);
  const network = toRecord(source?.network);
  const interfaces = Array.isArray(network?.interfaces)
    ? network.interfaces
    : Array.isArray(network?.ifaces)
      ? network.ifaces
      : Array.isArray(network?.adapters)
        ? network.adapters
        : [];

  let rxBytes = 0;
  let txBytes = 0;
  let found = false;
  for (const entry of interfaces) {
    const iface = toRecord(entry);
    const rx =
      readNumber(iface ?? {}, ['rxBytes']) ??
      readNumber(iface ?? {}, ['rx']) ??
      readNumber(iface ?? {}, ['receiveBytes']);
    const tx =
      readNumber(iface ?? {}, ['txBytes']) ??
      readNumber(iface ?? {}, ['tx']) ??
      readNumber(iface ?? {}, ['transmitBytes']);
    if (rx === null || tx === null) {
      continue;
    }
    rxBytes += rx;
    txBytes += tx;
    found = true;
  }

  return found ? { rxBytes, txBytes } : null;
}

/**
 * Implements read disk io counters.
 */
function readDiskIoCounters(snapshot: unknown) {
  const source = toRecord(snapshot);
  const storage = toRecord(source?.storage);
  const io = toRecord(storage?.io) ?? toRecord(storage?.diskIo) ?? storage;
  if (!io) {
    return null;
  }

  const readBytes =
    readNumber(io, ['readBytes']) ??
    readNumber(io, ['read_bytes']) ??
    readNumber(io, ['totalReadBytes']) ??
    readNumber(io, ['diskReadBytes']);
  const writeBytes =
    readNumber(io, ['writeBytes']) ??
    readNumber(io, ['write_bytes']) ??
    readNumber(io, ['totalWriteBytes']) ??
    readNumber(io, ['diskWriteBytes']);

  if (readBytes === null || writeBytes === null) {
    return null;
  }

  return { readBytes, writeBytes };
}

/**
 * Checks whether percent metric.
 */
function isPercentMetric(metric: LinkWidgetMetricId) {
  return metric === 'cpu' || metric === 'mem' || metric === 'disk';
}

/**
 * Implements format metric value.
 */
function formatMetricValue(metric: LinkWidgetMetricId, value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  if (isPercentMetric(metric)) {
    return `${value.toFixed(1)}%`;
  }
  return formatBytesPerSecond(value);
}

/**
 * Implements format bytes per second.
 */
function formatBytesPerSecond(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return '-';
  }

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Implements read number.
 */
function readNumber(input: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (typeof current === 'number' && Number.isFinite(current)) {
    return current;
  }
  if (typeof current === 'string') {
    const parsed = Number(current);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
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
 * Implements clamp pct.
 */
function clampPct(value: number) {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

/**
 * Implements format metric range.
 */
function formatMetricRange(points: MetricPoint[]) {
  if (points.length === 0) {
    return 'No samples yet.';
  }
  if (points.length === 1) {
    const onlyPoint = points[0];
    if (!onlyPoint) {
      return 'No samples yet.';
    }
    return `1 sample at ${new Date(onlyPoint.at).toLocaleTimeString()}`;
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (!firstPoint || !lastPoint) {
    return 'No samples yet.';
  }

  const first = new Date(firstPoint.at).toLocaleTimeString();
  const last = new Date(lastPoint.at).toLocaleTimeString();
  return `${points.length} samples (${first} - ${last})`;
}

/**
 * Implements read host.
 */
function readHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Creates local id.
 */
function createLocalId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Implements capitalize.
 */
function capitalize(value: string) {
  if (!value) {
    return value;
  }
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * Implements are dashboards equal.
 */
function areDashboardsEqual(left: LinksDashboard, right: LinksDashboard) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Implements reorder groups by id.
 */
function reorderGroupsById(groups: LinkGroup[], fromId: string, toId: string) {
  const fromIndex = groups.findIndex((group) => group.id === fromId);
  const toIndex = groups.findIndex((group) => group.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return groups;
  }

  const next = [...groups];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) {
    return groups;
  }
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Implements move tile by id.
 */
function moveTileById(
  dashboard: LinksDashboard,
  sourceGroupId: string,
  tileId: string,
  targetGroupId: string,
  targetTileId?: string,
): LinksDashboard {
  // Drag-and-drop helper that supports both reorder and cross-group moves.
  if (sourceGroupId === targetGroupId && targetTileId === tileId) {
    return dashboard;
  }

  const sourceGroupIndex = dashboard.groups.findIndex((group) => group.id === sourceGroupId);
  if (sourceGroupIndex < 0) {
    return dashboard;
  }

  const sourceGroup = dashboard.groups[sourceGroupIndex];
  if (!sourceGroup) {
    return dashboard;
  }

  const tileIndex = sourceGroup.tiles.findIndex((tile) => tile.id === tileId);
  if (tileIndex < 0) {
    return dashboard;
  }

  const tileToMove = sourceGroup.tiles[tileIndex];
  if (!tileToMove) {
    return dashboard;
  }
  const withoutSourceGroup = dashboard.groups.map<LinkGroup>((group, index) =>
    index === sourceGroupIndex
      ? {
          ...group,
          tiles: group.tiles.filter((tile) => tile.id !== tileId),
        }
      : group,
  );

  const targetGroupIndex = withoutSourceGroup.findIndex((group) => group.id === targetGroupId);
  if (targetGroupIndex < 0) {
    return dashboard;
  }

  const targetGroup = withoutSourceGroup[targetGroupIndex];
  if (!targetGroup) {
    return dashboard;
  }

  const nextTargetIndex = targetTileId
    ? targetGroup.tiles.findIndex((tile) => tile.id === targetTileId)
    : -1;
  const targetIndex = nextTargetIndex >= 0 ? nextTargetIndex : targetGroup.tiles.length;

  const updatedGroup = {
    ...targetGroup,
    tiles: [
      ...targetGroup.tiles.slice(0, targetIndex),
      tileToMove,
      ...targetGroup.tiles.slice(targetIndex),
    ],
  };

  const finalGroups = withoutSourceGroup.map((group, index) =>
    index === targetGroupIndex ? updatedGroup : group,
  );

  return {
    ...dashboard,
    groups: finalGroups,
  };
}

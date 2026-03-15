/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the app shell UI behavior.
 */
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Menu, LogOut, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  defaultSidebarNavigationOrderedItemIds,
  type SidebarNavItemId,
  type UiThemeSettingsResponse,
} from '@homelab/shared';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { applyUiThemeSettings, persistUiThemeSettings } from '@/lib/ui-theme';
import type {
  ProxmoxIntegrationSummary,
  SidebarNavigationUpdatePayload,
  UserPreferencesResponse,
} from '@/types/api';

// Shared shell layout: navigation, global search, auth controls, and outlet.
const proxmoxSidebarNavItemId = 'proxmox' as const;
type RuntimeSidebarNavItemId = SidebarNavItemId | typeof proxmoxSidebarNavItemId;

type SidebarNavItem = {
  id: RuntimeSidebarNavItemId;
  to: string;
  label: string;
};

const sidebarNavItemById: Record<RuntimeSidebarNavItemId, SidebarNavItem> = {
  dashboard: { id: 'dashboard', to: '/dashboard', label: 'Dashboard' },
  'dashboard-agent': { id: 'dashboard-agent', to: '/dashboard-agent', label: 'Dashboard Agent' },
  hosts: { id: 'hosts', to: '/hosts', label: 'Hosts' },
  proxmox: { id: 'proxmox', to: '/proxmox', label: 'Proxmox' },
  'network-monitors': { id: 'network-monitors', to: '/monitors', label: 'Network Monitors' },
  alerts: { id: 'alerts', to: '/alerts', label: 'Alerts' },
  'service-discovery': {
    id: 'service-discovery',
    to: '/service-discovery',
    label: 'Service Discovery',
  },
  'agent-management': {
    id: 'agent-management',
    to: '/agent-management',
    label: 'Agent Management',
  },
  ai: { id: 'ai', to: '/ai', label: 'AI' },
  settings: { id: 'settings', to: '/settings', label: 'Settings' },
};

const desktopSidebarMediaQuery = '(min-width: 1024px)';

/**
 * Builds default sidebar order.
 */
function buildDefaultSidebarOrder() {
  const seededOrder = defaultSidebarNavigationOrderedItemIds.slice() as RuntimeSidebarNavItemId[];
  if (seededOrder.includes(proxmoxSidebarNavItemId)) {
    return seededOrder;
  }

  const hostsIndex = seededOrder.indexOf('hosts');
  if (hostsIndex >= 0) {
    seededOrder.splice(hostsIndex + 1, 0, proxmoxSidebarNavItemId);
    return seededOrder;
  }

  seededOrder.push(proxmoxSidebarNavItemId);
  return seededOrder;
}

const defaultSidebarOrder = buildDefaultSidebarOrder();

/**
 * Gets is desktop sidebar.
 */
function getIsDesktopSidebar() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }

  return window.matchMedia(desktopSidebarMediaQuery).matches;
}

/**
 * Implements normalize sidebar navigation order.
 */
function normalizeSidebarNavigationOrder(
  orderedItemIds: readonly RuntimeSidebarNavItemId[] | null | undefined,
) {
  const seen = new Set<RuntimeSidebarNavItemId>();
  const normalized: RuntimeSidebarNavItemId[] = [];

  for (const candidate of orderedItemIds ?? []) {
    const id = candidate as RuntimeSidebarNavItemId;
    if (seen.has(id) || !sidebarNavItemById[id]) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }

  for (const id of defaultSidebarOrder) {
    if (seen.has(id)) {
      continue;
    }
    normalized.push(id);
  }

  return normalized;
}

/**
 * Implements move sidebar item.
 */
function moveSidebarItem(
  order: RuntimeSidebarNavItemId[],
  itemId: RuntimeSidebarNavItemId,
  direction: -1 | 1,
) {
  const index = order.indexOf(itemId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= order.length) {
    return order;
  }

  const next = order.slice();
  const item = next[index];
  if (!item) {
    return order;
  }
  next.splice(index, 1);
  next.splice(targetIndex, 0, item);
  return next;
}

/**
 * Implements reorder sidebar items.
 */
function reorderSidebarItems(
  order: RuntimeSidebarNavItemId[],
  draggedItemId: RuntimeSidebarNavItemId,
  targetItemId: RuntimeSidebarNavItemId,
) {
  if (draggedItemId === targetItemId) {
    return order;
  }

  const sourceIndex = order.indexOf(draggedItemId);
  const targetIndex = order.indexOf(targetItemId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return order;
  }

  const next = order.slice();
  const item = next[sourceIndex];
  if (!item) {
    return order;
  }
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, item);
  return next;
}

/**
 * Renders the app shell view.
 */
export function AppShell() {
  const [search, setSearch] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopSidebarViewport, setDesktopSidebarViewport] = useState(getIsDesktopSidebar);
  const [sidebarOrder, setSidebarOrder] = useState<RuntimeSidebarNavItemId[]>(defaultSidebarOrder);
  const [draggedSidebarItemId, setDraggedSidebarItemId] = useState<RuntimeSidebarNavItemId | null>(
    null,
  );
  const [dropTargetSidebarItemId, setDropTargetSidebarItemId] =
    useState<RuntimeSidebarNavItemId | null>(null);
  const [sidebarSaveError, setSidebarSaveError] = useState<string | null>(null);
  const [sidebarLiveMessage, setSidebarLiveMessage] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuth();

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: () => apiFetch<Array<Record<string, unknown>>>('/api/hosts'),
  });

  const themeQuery = useQuery({
    queryKey: ['ui-theme'],
    queryFn: () => apiFetch<UiThemeSettingsResponse>('/api/account/theme'),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  const preferencesQuery = useQuery({
    queryKey: ['user-preferences'],
    queryFn: () => apiFetch<UserPreferencesResponse>('/api/account/preferences'),
  });
  const proxmoxIntegrationsQuery = useQuery({
    queryKey: ['proxmox-integrations'],
    queryFn: () => apiFetch<ProxmoxIntegrationSummary[]>('/api/proxmox/integrations'),
    staleTime: 30_000,
  });

  const saveSidebarNavigationMutation = useMutation({
    mutationFn: (payload: SidebarNavigationUpdatePayload) =>
      apiFetch<UserPreferencesResponse>('/api/account/preferences/sidebar-navigation', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onMutate: () => {
      setSidebarSaveError(null);
      setSidebarLiveMessage('Saving tab order.');

      return {
        previousSidebarOrder: savedSidebarOrderRef.current,
      };
    },
    onSuccess: async (response) => {
      const nextSidebarOrder = normalizeSidebarNavigationOrder(
        response.preferences.sidebarNavigation?.orderedItemIds,
      );

      queryClient.setQueryData(['user-preferences'], response);
      setSidebarOrder(nextSidebarOrder);
      setSidebarSaveError(null);
      setSidebarLiveMessage('Tab order saved.');
      setDraggedSidebarItemId(null);
      setDropTargetSidebarItemId(null);
      await queryClient.invalidateQueries({ queryKey: ['user-preferences'] });
    },
    onError: (error, _payload, context) => {
      const message = error instanceof Error ? error.message : 'Failed to save sidebar order.';

      setSidebarOrder(context?.previousSidebarOrder ?? savedSidebarOrder);
      setSidebarSaveError(message);
      setSidebarLiveMessage(message);
      setDraggedSidebarItemId(null);
      setDropTargetSidebarItemId(null);
    },
  });

  const savedSidebarOrder = normalizeSidebarNavigationOrder(
    preferencesQuery.data?.preferences.sidebarNavigation?.orderedItemIds as
      | RuntimeSidebarNavItemId[]
      | undefined,
  );
  const savedSidebarOrderRef = useRef(savedSidebarOrder);
  const savedSidebarOrderKey = savedSidebarOrder.join('|');
  const sidebarOrderKey = sidebarOrder.join('|');
  const hasEnabledProxmox = (proxmoxIntegrationsQuery.data ?? []).some(
    (integration) => integration.enabled,
  );
  const visibleSidebarOrder = sidebarOrder.filter(
    (itemId) => itemId !== proxmoxSidebarNavItemId || hasEnabledProxmox,
  );
  const visibleSidebarItems = visibleSidebarOrder.map((itemId) => sidebarNavItemById[itemId]);

  useEffect(() => {
    if (!themeQuery.data) {
      return;
    }
    // Keep DOM theme and local storage aligned with server-side user settings.
    applyUiThemeSettings(themeQuery.data.theme);
    persistUiThemeSettings(themeQuery.data.theme);
  }, [themeQuery.data]);

  useEffect(() => {
    savedSidebarOrderRef.current = savedSidebarOrder;
  }, [savedSidebarOrder, savedSidebarOrderKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(desktopSidebarMediaQuery);
    /**
     * Implements sync viewport.
     */
    const syncViewport = (event?: MediaQueryListEvent) => {
      setDesktopSidebarViewport(event?.matches ?? mediaQuery.matches);
    };

    syncViewport();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncViewport);
    } else {
      mediaQuery.addListener(syncViewport);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', syncViewport);
      } else {
        mediaQuery.removeListener(syncViewport);
      }
    };
  }, []);

  useEffect(() => {
    if (saveSidebarNavigationMutation.isPending || draggedSidebarItemId) {
      return;
    }
    setSidebarOrder(savedSidebarOrderRef.current);
  }, [draggedSidebarItemId, saveSidebarNavigationMutation.isPending, savedSidebarOrderKey]);

  useEffect(() => {
    if (desktopSidebarViewport) {
      return;
    }

    setDraggedSidebarItemId(null);
    setDropTargetSidebarItemId(null);
  }, [desktopSidebarViewport]);

  const searchItems = [
    ...(hostsQuery.data ?? []).map((item) => ({
      type: 'host',
      id: String(item.id ?? ''),
      label: String(item.hostname ?? 'unknown-host'),
      href: `/hosts/${item.id as string}`,
    })),
  ].filter((item) => item.id);

  const filtered =
    search.trim().length > 0
      ? searchItems
          .filter((item) => item.label.toLowerCase().includes(search.toLowerCase()))
          .slice(0, 8)
      : [];

  /**
   * Implements persist sidebar order.
   */
  const persistSidebarOrder = (nextVisibleOrder: RuntimeSidebarNavItemId[]) => {
    const nextOrder = nextVisibleOrder.slice();
    if (!hasEnabledProxmox && sidebarOrder.includes(proxmoxSidebarNavItemId)) {
      const hiddenIndex = sidebarOrder.indexOf(proxmoxSidebarNavItemId);
      nextOrder.splice(Math.min(hiddenIndex, nextOrder.length), 0, proxmoxSidebarNavItemId);
    }

    const nextOrderKey = nextOrder.join('|');
    if (nextOrderKey === sidebarOrderKey) {
      setDraggedSidebarItemId(null);
      setDropTargetSidebarItemId(null);
      return;
    }

    setSidebarSaveError(null);
    setSidebarLiveMessage('');
    setDraggedSidebarItemId(null);
    setDropTargetSidebarItemId(null);
    setSidebarOrder(nextOrder);
    saveSidebarNavigationMutation.mutate({
      confirm: true,
      orderedItemIds: nextOrder as SidebarNavItemId[],
    });
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
      <aside
        className={cn(
          'theme-shell-sidebar fixed inset-y-0 left-0 z-40 w-64 transform border-r border-border bg-card/95 p-4 backdrop-blur transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Link
          to="/dashboard"
          className="mb-6 block text-lg font-semibold tracking-tight text-foreground"
        >
          Homelab Control Plane
        </Link>
        <div
          aria-live="polite"
          className={cn(
            'mb-3 min-h-4 text-xs',
            sidebarSaveError ? 'text-rose-400' : 'text-muted-foreground',
          )}
        >
          {sidebarSaveError ?? (desktopSidebarViewport ? sidebarLiveMessage : '')}
        </div>
        <nav aria-label="Primary navigation" className="space-y-1">
          {visibleSidebarItems.map((item) => (
            <div
              key={item.id}
              className={cn(
                'lg:flex lg:items-center lg:gap-2 lg:rounded-md lg:px-2 lg:py-1',
                desktopSidebarViewport && dropTargetSidebarItemId === item.id && 'lg:bg-primary/10',
              )}
              data-sidebar-nav-id={item.id}
              onDragOver={(event) => {
                if (
                  !desktopSidebarViewport ||
                  !draggedSidebarItemId ||
                  saveSidebarNavigationMutation.isPending
                ) {
                  return;
                }
                event.preventDefault();
                if (dropTargetSidebarItemId !== item.id) {
                  setDropTargetSidebarItemId(item.id);
                }
              }}
              onDrop={(event) => {
                if (
                  !desktopSidebarViewport ||
                  !draggedSidebarItemId ||
                  saveSidebarNavigationMutation.isPending
                ) {
                  return;
                }

                event.preventDefault();
                const nextOrder = reorderSidebarItems(
                  visibleSidebarOrder,
                  draggedSidebarItemId,
                  item.id,
                );
                persistSidebarOrder(nextOrder);
              }}
            >
              {desktopSidebarViewport ? (
                <button
                  type="button"
                  className="hidden h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 lg:flex active:cursor-grabbing"
                  draggable={!saveSidebarNavigationMutation.isPending}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  aria-label={`Drag ${item.label}`}
                  disabled={saveSidebarNavigationMutation.isPending}
                  onDragStart={(event) => {
                    if (saveSidebarNavigationMutation.isPending) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer?.setData('text/plain', item.id);
                    event.dataTransfer?.setData('application/x-homelab-sidebar-nav-item', item.id);
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = 'move';
                    }
                    setSidebarSaveError(null);
                    setSidebarLiveMessage('');
                    setDraggedSidebarItemId(item.id);
                  }}
                  onDragEnd={() => {
                    setDraggedSidebarItemId(null);
                    setDropTargetSidebarItemId(null);
                  }}
                  onKeyDown={(event) => {
                    if (saveSidebarNavigationMutation.isPending) {
                      return;
                    }

                    const direction =
                      event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null;
                    if (direction === null) {
                      return;
                    }

                    event.preventDefault();
                    const nextOrder = moveSidebarItem(visibleSidebarOrder, item.id, direction);
                    persistSidebarOrder(nextOrder);
                  }}
                  title="Drag to reorder or use arrow keys."
                >
                  <Menu className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'block min-w-0 rounded-md px-3 py-2 text-sm transition lg:flex-1',
                    isActive
                      ? 'bg-primary/20 text-primary'
                      : 'text-muted-foreground hover:bg-secondary/40',
                  )
                }
                onClick={() => setMobileOpen(false)}
              >
                <span className="block truncate">{item.label}</span>
              </NavLink>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="theme-shell-header sticky top-0 z-30 border-b border-border bg-background/80 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setMobileOpen((v) => !v)}
            >
              <Menu className="h-4 w-4" />
            </Button>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-8"
                placeholder="Search hosts"
              />
              {filtered.length > 0 && (
                <div className="absolute mt-2 w-full rounded-md border border-border bg-card shadow-xl">
                  {filtered.map((item) => (
                    <button
                      key={`${item.type}:${item.id}`}
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-secondary/50"
                      onClick={() => {
                        setSearch('');
                        void navigate(item.href);
                      }}
                    >
                      <span>{item.label}</span>
                      <span className="text-xs uppercase text-muted-foreground">{item.type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="h-4 w-4" />
            </Button>
            <div className="hidden text-xs text-muted-foreground sm:block">{user?.displayName}</div>
          </div>
        </header>

        <main className="flex-1 px-4 py-5 lg:px-8">
          <div className="animate-pulseIn">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

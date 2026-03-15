/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the home page route view.
 */
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  CircleOff,
  CircleX,
  HeartPulse,
  Server,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { formatTimeAgo, formatTimestamp } from '@/lib/time';
import type { HomeRecentEvent, HomeSummaryResponse } from '@/types/api';
import { PageSkeleton } from '@/components/page-skeleton';

// Legacy home view. Dashboard is primary, but this page remains as a read-only
// summary with event detail overlay.
export function HomePage() {
  const [selectedEvent, setSelectedEvent] = useState<HomeRecentEvent | null>(null);

  const query = useQuery({
    queryKey: ['home-summary'],
    queryFn: () => apiFetch<HomeSummaryResponse>('/api/home/summary'),
  });

  if (query.isLoading) {
    return <PageSkeleton />;
  }

  if (query.isError || !query.data) {
    return <div className="text-sm text-rose-400">Failed to load home summary.</div>;
  }

  const { cards, whatsBroken, recentEvents, topConsumers } = query.data;
  const normalizedEvents = recentEvents.map(normalizeHomeEvent);

  return (
    <>
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold">Home</h1>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            title="Hosts Online"
            value={String(cards.hostsOnline)}
            icon={<Server className="h-4 w-4" />}
          />
          <SummaryCard
            title="Hosts Offline"
            value={String(cards.hostsOffline)}
            icon={<CircleOff className="h-4 w-4" />}
          />
          <SummaryCard
            title="Active Alerts"
            value={String(cards.activeAlerts)}
            icon={<AlertTriangle className="h-4 w-4" />}
          />
          <SummaryCard
            title="Failing Monitors"
            value={String(cards.failingChecks)}
            icon={<HeartPulse className="h-4 w-4" />}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>What&apos;s Broken</CardTitle>
              <CardDescription>Active alerts, failing monitors, and offline hosts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {[...whatsBroken.alerts, ...whatsBroken.downChecks, ...whatsBroken.offlineHosts]
                .slice(0, 20)
                .map((item, index) => (
                  <div key={index} className="rounded-md border border-border/50 px-3 py-2">
                    {String(item.message ?? item.name ?? item.hostname ?? 'Unknown issue')}
                  </div>
                ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Events</CardTitle>
              <CardDescription>
                Latest events from the event stream (showing 10 at a time).
              </CardDescription>
            </CardHeader>
            <CardContent className="max-h-[31rem] space-y-2 overflow-y-auto pr-1 text-sm">
              {normalizedEvents.slice(0, 10).map((event, index) => (
                <button
                  key={event.id || index}
                  type="button"
                  className="w-full rounded-md border border-border/50 px-3 py-2 text-left transition hover:border-border hover:bg-secondary/20"
                  onClick={() => setSelectedEvent(event)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2">
                      <span className={eventTone(event.severity)} aria-hidden="true">
                        <EventSeverityIcon severity={event.severity} />
                      </span>
                      <div>
                        <div className="font-medium">{String(event.type || 'event')}</div>
                        <div className="text-muted-foreground">{String(event.message || '')}</div>
                      </div>
                    </div>
                    <div
                      className="shrink-0 text-xs text-muted-foreground"
                      title={formatTimestamp(event.createdAt)}
                    >
                      {formatTimeAgo(event.createdAt)}
                    </div>
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Top Resource Consumers</CardTitle>
            <CardDescription>Latest host snapshots by CPU/memory/disk usage.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {topConsumers.map((host, index) => (
              <div key={index} className="rounded-md border border-border/50 px-3 py-2 text-sm">
                <div className="font-medium">{String(host.hostname ?? 'unknown')}</div>
                <div className="text-muted-foreground">
                  CPU {Number(host.cpuPct ?? 0).toFixed(1)}% | MEM{' '}
                  {Number(host.memPct ?? 0).toFixed(1)}% | DISK{' '}
                  {Number(host.diskPct ?? 0).toFixed(1)}%
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={Boolean(selectedEvent)}
        onOpenChange={(open) => (open ? null : setSelectedEvent(null))}
      >
        <DialogContent>
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-lg font-semibold">Event Details</div>
                <div className="text-sm text-muted-foreground">
                  Additional context for this event.
                </div>
              </div>
              <DialogClose asChild>
                <Button variant="outline" size="sm">
                  Close
                </Button>
              </DialogClose>
            </div>

            {selectedEvent && (
              <div className="space-y-3 text-sm">
                <div className="rounded-md border border-border/60 bg-background/60 p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={eventTone(selectedEvent.severity)} aria-hidden="true">
                      <EventSeverityIcon severity={selectedEvent.severity} />
                    </span>
                    <span className="font-medium">{selectedEvent.type || 'event'}</span>
                    <span className="text-xs uppercase text-muted-foreground">
                      {selectedEvent.severity || 'INFO'}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    {selectedEvent.message || 'No event message.'}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <MetaLine label="Created" value={formatTimestamp(selectedEvent.createdAt)} />
                  <MetaLine label="Event ID" value={selectedEvent.id || '-'} />
                  <MetaLine label="Host ID" value={selectedEvent.hostId || '-'} />
                  <MetaLine label="Service ID" value={selectedEvent.serviceId || '-'} />
                  <MetaLine label="Check ID" value={selectedEvent.checkId || '-'} />
                </div>

                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Payload
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-background/70 p-3 text-xs">
                    {JSON.stringify(selectedEvent.payload ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Implements normalize home event.
 */
function normalizeHomeEvent(event: HomeRecentEvent): HomeRecentEvent {
  return {
    id: String(event.id ?? ''),
    type: String(event.type ?? 'event'),
    message: String(event.message ?? ''),
    severity: normalizeSeverity(String(event.severity ?? 'INFO')),
    hostId: event.hostId ? String(event.hostId) : null,
    serviceId: event.serviceId ? String(event.serviceId) : null,
    checkId: event.checkId ? String(event.checkId) : null,
    payload: (event.payload as Record<string, unknown> | null | undefined) ?? null,
    createdAt: event.createdAt ? String(event.createdAt) : undefined,
  };
}

/**
 * Implements normalize severity.
 */
function normalizeSeverity(value: string): HomeRecentEvent['severity'] {
  const normalized = value.toUpperCase();
  if (normalized === 'ERROR' || normalized === 'CRIT') {
    return 'ERROR';
  }
  if (normalized === 'WARN' || normalized === 'WARNING') {
    return 'WARN';
  }
  return 'INFO';
}

/**
 * Renders the event severity icon view.
 */
function EventSeverityIcon({ severity }: { severity: string }) {
  const normalized = normalizeSeverity(severity);
  if (normalized === 'ERROR') {
    return <CircleX className="h-4 w-4" />;
  }
  if (normalized === 'WARN') {
    return <CircleAlert className="h-4 w-4" />;
  }
  return <CircleCheck className="h-4 w-4" />;
}

/**
 * Implements event tone.
 */
function eventTone(severity: string) {
  const normalized = normalizeSeverity(severity);
  if (normalized === 'ERROR') {
    return 'text-red-500';
  }
  if (normalized === 'WARN') {
    return 'text-amber-500';
  }
  return 'text-emerald-500';
}

/**
 * Renders the meta line view.
 */
function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/50 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}

/**
 * Renders the summary card view.
 */
function SummaryCard({ title, value, icon }: { title: string; value: string; icon: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the check detail page route view.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import type { CheckDetail, CheckHistoryEntry } from '@/types/api';

// Monitor detail page with current config and 24h execution history.
export function MonitorDetailPage() {
  const params = useParams();
  const monitorId = params.id;

  const checkQuery = useQuery({
    queryKey: ['monitor', monitorId],
    enabled: Boolean(monitorId),
    queryFn: () => apiFetch<CheckDetail>(`/api/checks/${monitorId}`),
  });

  const historyQuery = useQuery({
    queryKey: ['monitor-history', monitorId],
    enabled: Boolean(monitorId),
    queryFn: () => apiFetch<CheckHistoryEntry[]>(`/api/checks/${monitorId}/history?hours=24`),
  });

  if (checkQuery.isLoading || historyQuery.isLoading) {
    return <PageSkeleton />;
  }

  if (checkQuery.isError || historyQuery.isError || !checkQuery.data) {
    return <div className="text-sm text-rose-400">Failed to load monitor detail.</div>;
  }

  const check = checkQuery.data;
  const history = [...(historyQuery.data ?? [])]
    .sort((left, right) => new Date(right.checkedAt).getTime() - new Date(left.checkedAt).getTime())
    .slice(0, 20);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{check.name}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Type: {check.type} | Target: {check.target} | Interval: {check.intervalSec}s | Timeout:{' '}
          {check.timeoutMs}ms
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monitor History (24h)</CardTitle>
        </CardHeader>
        <CardContent className="max-h-96 space-y-2 overflow-y-auto pr-1 text-sm">
          {history.map((entry) => (
            <div key={entry.id} className="rounded-md border border-border/60 p-2">
              <div className="font-medium">{entry.status}</div>
              <div className="text-muted-foreground">
                {new Date(entry.checkedAt).toLocaleString()}
              </div>
              <div className="text-muted-foreground">
                latency={entry.latencyMs ?? '-'}ms status={entry.httpStatus ?? '-'} err=
                {entry.errorMessage ?? '-'}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

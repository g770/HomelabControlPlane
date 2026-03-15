/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the services page route view.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthBadge } from '@/components/health-badge';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import { summarizeServiceInstanceStates } from '@/lib/service-state';

/**
 * Renders the services page view.
 */
export function ServicesPage() {
  const query = useQuery({
    queryKey: ['services'],
    queryFn: () => apiFetch<Array<Record<string, unknown>>>('/api/services'),
  });

  if (query.isLoading) {
    return <PageSkeleton />;
  }

  if (query.isError || !query.data) {
    return <div className="text-sm text-rose-400">Failed to load services.</div>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Services</h1>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {query.data.map((service) => {
          const instances = Array.isArray(service.instances) ? service.instances : [];
          const stateSummary = summarizeServiceInstanceStates(instances);
          return (
            <Card key={String(service.id)}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2 text-base">
                  <Link to={`/services/${service.id as string}`}>
                    {String(service.name ?? 'unknown')}
                  </Link>
                  <HealthBadge status={String(service.status ?? 'UNKNOWN')} />
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                <div>Tags: {Array.isArray(service.tags) ? service.tags.join(', ') : 'none'}</div>
                <div className="mt-1">States: {stateSummary}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

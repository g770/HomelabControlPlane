/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the service detail page route view.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthBadge } from '@/components/health-badge';
import { PageSkeleton } from '@/components/page-skeleton';
import { apiFetch } from '@/lib/api';
import { serviceInstanceStateLabel } from '@/lib/service-state';
import type { ServiceDetail } from '@/types/api';

/**
 * Renders the service detail page view.
 */
export function ServiceDetailPage() {
  const params = useParams();
  const serviceId = params.id;

  const query = useQuery({
    queryKey: ['service', serviceId],
    enabled: Boolean(serviceId),
    queryFn: () => apiFetch<ServiceDetail>(`/api/services/${serviceId}`),
  });

  if (query.isLoading) {
    return <PageSkeleton />;
  }

  if (query.isError || !query.data) {
    return <div className="text-sm text-rose-400">Failed to load service detail.</div>;
  }

  const service = query.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {service.name} <HealthBadge status={service.status} />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Source: {String(service.source ?? 'unknown')} | Tags:{' '}
          {Array.isArray(service.tags) ? service.tags.join(', ') : ''}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instances</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(service.instances ?? []).map((instance) => (
            <div key={instance.id} className="rounded-md border border-border/60 p-2">
              <div className="font-medium">{instance.name}</div>
              <div className="text-muted-foreground">Host: {instance.host?.hostname ?? 'n/a'}</div>
              <div className="text-muted-foreground">
                State: {serviceInstanceStateLabel(instance)}
              </div>
              <div className="text-muted-foreground">Endpoint: {instance.endpoint ?? 'n/a'}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Events</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(service.events ?? []).map((event) => (
            <div key={event.id} className="rounded-md border border-border/60 p-2">
              <div className="font-medium">{event.type}</div>
              <div className="text-muted-foreground">{event.message}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

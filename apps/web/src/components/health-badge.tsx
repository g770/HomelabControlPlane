/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the health badge UI behavior.
 */
import { Badge } from '@/components/ui/badge';
import { healthColorMap } from '@/lib/utils';

/**
 * Renders the health badge view.
 */
export function HealthBadge({
  status,
  label,
}: {
  status: string | null | undefined;
  label?: string | null | undefined;
}) {
  const safeStatus = status ?? 'UNKNOWN';
  const badgeLabel =
    typeof label === 'string' && label.trim().length > 0 ? label.trim() : safeStatus;
  return (
    <Badge className={healthColorMap[safeStatus] ?? healthColorMap.UNKNOWN}>{badgeLabel}</Badge>
  );
}

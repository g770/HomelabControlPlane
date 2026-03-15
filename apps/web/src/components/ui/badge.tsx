/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the badge UI behavior.
 */
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Renders the badge view.
 */
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'theme-badge inline-flex items-center rounded-md border border-border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide',
        className,
      )}
      {...props}
    />
  );
}

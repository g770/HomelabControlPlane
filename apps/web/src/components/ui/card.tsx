/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the card UI behavior.
 */
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Renders the card view.
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'theme-card rounded-xl border border-border/80 bg-card/80 text-card-foreground shadow-lg backdrop-blur',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Renders the card header view.
 */
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5 pb-3', className)} {...props} />;
}

/**
 * Renders the card title view.
 */
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('font-display text-base font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

/**
 * Renders the card description view.
 */
export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

/**
 * Renders the card content view.
 */
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

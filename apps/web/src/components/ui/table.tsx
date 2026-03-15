/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This component module renders the table UI behavior.
 */
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Renders the table view.
 */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full caption-bottom text-sm', className)} {...props} />;
}

/**
 * Renders the table header view.
 */
export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn('theme-table-header border-b border-border/80', className)} {...props} />
  );
}

/**
 * Renders the table body view.
 */
export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

/**
 * Renders the table row view.
 */
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'theme-table-row border-b border-border/60 transition-colors hover:bg-secondary/30',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Renders the table head view.
 */
export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'theme-table-head font-display h-10 px-2 text-left align-middle text-xs font-semibold uppercase text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Renders the table cell view.
 */
export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('p-2 align-middle', className)} {...props} />;
}

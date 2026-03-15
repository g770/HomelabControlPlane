/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This page module renders the components route view.
 */
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MetricPoint, ThroughputPoint } from './types';
import { clampPct, formatRange, formatRangeFromThroughput, normalizeSeverity } from './utils';

/**
 * Renders the metric trend card view.
 */
export function MetricTrendCard({
  title,
  points,
  toneClass,
  onAddToLinks,
  addDisabled,
}: {
  title: string;
  points: MetricPoint[];
  toneClass: string;
  onAddToLinks?: () => void;
  addDisabled?: boolean;
}) {
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const delta = latest && previous ? latest.value - previous.value : null;

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs uppercase text-muted-foreground">{title}</div>
        <div className="flex items-center gap-2">
          <div className={`text-xs ${toneClass}`}>
            {delta === null ? '-' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}
          </div>
          {onAddToLinks && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAddToLinks}
              disabled={addDisabled}
            >
              Add to Dashboard
            </Button>
          )}
        </div>
      </div>
      <div className={`mt-1 text-lg font-medium ${toneClass}`}>
        {latest ? `${latest.value.toFixed(1)}%` : '-'}
      </div>
      <Sparkline points={points} toneClass={toneClass} />
      <div className="mt-2 text-xs text-muted-foreground">{formatRange(points)}</div>
    </div>
  );
}

/**
 * Renders the sparkline view.
 */
function Sparkline({ points, toneClass }: { points: MetricPoint[]; toneClass: string }) {
  if (points.length === 0) {
    return (
      <div className="mt-3 h-20 rounded border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground" />
    );
  }

  const maxIndex = Math.max(points.length - 1, 1);
  const graphHeight = 40;
  const pointsText = points
    .map((point, index) => {
      const x = (index / maxIndex) * 100;
      const y = graphHeight - (clampPct(point.value) / 100) * graphHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const latest = points[points.length - 1];
  if (!latest) {
    return (
      <div className="mt-3 h-20 rounded border border-dashed border-border/60 bg-background/40 text-xs text-muted-foreground" />
    );
  }
  const latestX = (maxIndex / maxIndex) * 100;
  const latestY = graphHeight - (clampPct(latest.value) / 100) * graphHeight;

  return (
    <div className={`mt-3 ${toneClass}`}>
      <svg viewBox="0 0 100 40" className="h-20 w-full">
        <line x1="0" y1="10" x2="100" y2="10" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <line x1="0" y1="20" x2="100" y2="20" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <line x1="0" y1="30" x2="100" y2="30" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <polyline
          points={pointsText}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx={latestX} cy={latestY} r="1.8" fill="currentColor" />
      </svg>
    </div>
  );
}

/**
 * Renders the dual trend card view.
 */
export function DualTrendCard({
  title,
  points,
  primaryLabel,
  secondaryLabel,
  primaryToneClass,
  secondaryToneClass,
  formatter,
  emptyText,
  onAddToLinks,
  addDisabled,
}: {
  title: string;
  points: ThroughputPoint[];
  primaryLabel: string;
  secondaryLabel: string;
  primaryToneClass: string;
  secondaryToneClass: string;
  formatter: (value: number) => string;
  emptyText: string;
  onAddToLinks?: () => void;
  addDisabled?: boolean;
}) {
  const latest = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs uppercase text-muted-foreground">{title}</div>
        {onAddToLinks && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAddToLinks}
            disabled={addDisabled}
          >
            Add to Dashboard
          </Button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        <span className={primaryToneClass}>
          {primaryLabel}: {latest ? formatter(latest.primary) : '-'}
        </span>
        <span className={secondaryToneClass}>
          {secondaryLabel}: {latest ? formatter(latest.secondary) : '-'}
        </span>
      </div>
      <DualSparkline
        points={points}
        primaryToneClass={primaryToneClass}
        secondaryToneClass={secondaryToneClass}
        emptyText={emptyText}
      />
      <div className="mt-2 text-xs text-muted-foreground">{formatRangeFromThroughput(points)}</div>
    </div>
  );
}

/**
 * Renders the dual sparkline view.
 */
function DualSparkline({
  points,
  primaryToneClass,
  secondaryToneClass,
  emptyText,
}: {
  points: ThroughputPoint[];
  primaryToneClass: string;
  secondaryToneClass: string;
  emptyText: string;
}) {
  if (points.length === 0) {
    return (
      <div className="mt-3 flex h-20 items-center rounded border border-dashed border-border/60 bg-background/40 px-2 text-xs text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  const maxIndex = Math.max(points.length - 1, 1);
  const graphHeight = 40;
  let maxValue = 1;
  for (const point of points) {
    maxValue = Math.max(maxValue, point.primary, point.secondary);
  }

  const primaryLine = points
    .map((point, index) => {
      const x = (index / maxIndex) * 100;
      const y = graphHeight - (point.primary / maxValue) * graphHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const secondaryLine = points
    .map((point, index) => {
      const x = (index / maxIndex) * 100;
      const y = graphHeight - (point.secondary / maxValue) * graphHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const latest = points[points.length - 1];
  if (!latest) {
    return (
      <div className="mt-3 flex h-20 items-center rounded border border-dashed border-border/60 bg-background/40 px-2 text-xs text-muted-foreground">
        {emptyText}
      </div>
    );
  }

  const latestX = 100;
  const latestPrimaryY = graphHeight - (latest.primary / maxValue) * graphHeight;
  const latestSecondaryY = graphHeight - (latest.secondary / maxValue) * graphHeight;

  return (
    <div className="mt-3">
      <svg viewBox="0 0 100 40" className="h-20 w-full">
        <line x1="0" y1="10" x2="100" y2="10" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <line x1="0" y1="20" x2="100" y2="20" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <line x1="0" y1="30" x2="100" y2="30" stroke="rgb(100 116 139 / 0.25)" strokeWidth="0.6" />
        <g className={secondaryToneClass}>
          <polyline
            points={secondaryLine}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx={latestX} cy={latestSecondaryY} r="1.4" fill="currentColor" />
        </g>
        <g className={primaryToneClass}>
          <polyline
            points={primaryLine}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx={latestX} cy={latestPrimaryY} r="1.7" fill="currentColor" />
        </g>
      </svg>
    </div>
  );
}

/**
 * Renders the section view.
 */
export function Section({ title, data }: { title: string; data: unknown }) {
  return (
    <div>
      <p className="text-xs uppercase text-muted-foreground">{title}</p>
      <pre className="mt-1 max-h-32 overflow-auto rounded border border-border/50 bg-background/70 p-2 text-xs">
        {JSON.stringify(data ?? {}, null, 2)}
      </pre>
    </div>
  );
}

/**
 * Renders the bullet section view.
 */
export function BulletSection({ title, bullets }: { title: string; bullets: string[] }) {
  return (
    <div className="rounded border border-border/50 bg-background/50 p-2">
      <p className="text-xs uppercase text-muted-foreground">{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
        {bullets.map((bullet, index) => (
          <li key={`${title}-${index}`}>{bullet}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Renders the summary placeholder view.
 */
export function SummaryPlaceholder({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-border/60 bg-background/40 p-3 text-xs text-muted-foreground">
      {text}
    </div>
  );
}

/**
 * Renders the event severity icon view.
 */
export function EventSeverityIcon({ severity }: { severity: string }) {
  const normalized = normalizeSeverity(severity);
  if (normalized === 'ERROR') {
    return <CircleX className="h-4 w-4" />;
  }
  if (normalized === 'WARN') {
    return <CircleAlert className="h-4 w-4" />;
  }
  return <CircleCheck className="h-4 w-4" />;
}

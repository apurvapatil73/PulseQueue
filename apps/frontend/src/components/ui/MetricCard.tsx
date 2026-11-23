import React from 'react';
import { Card } from './Card';
import { Skeleton } from './Skeleton';

export interface MetricCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon?: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  isLoading?: boolean;
}

const TONE_ICON_STYLES: Record<NonNullable<MetricCardProps['tone']>, string> = {
  default: 'text-sky-400 bg-sky-400/10 border-sky-400/20',
  success: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  warning: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  danger: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
};

export function MetricCard({
  label,
  value,
  subtext,
  icon,
  tone = 'default',
  isLoading = false,
}: MetricCardProps) {
  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="flex items-start justify-between">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-7 w-7 rounded-lg" />
        </div>
        <Skeleton className="mt-3 h-7 w-20" />
        <Skeleton className="mt-2 h-3 w-32" />
      </Card>
    );
  }

  return (
    <Card className="p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        {icon && (
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${TONE_ICON_STYLES[tone]}`}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2.5 text-2xl font-semibold tracking-tight text-slate-50 font-mono tabular-nums">
        {value}
      </div>
      {subtext && <p className="mt-1 text-xs text-slate-400 truncate">{subtext}</p>}
    </Card>
  );
}

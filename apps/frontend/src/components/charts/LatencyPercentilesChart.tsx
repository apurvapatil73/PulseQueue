import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Gauge } from 'lucide-react';
import type {
  LatencyDistribution,
  OrganisationMetricsView,
  OrganisationTimeseriesView,
} from '../../types/api';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

interface LatencyPercentilesChartProps {
  latency?: OrganisationMetricsView['latency'];
  timeseries?: OrganisationTimeseriesView;
  isLoading?: boolean;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTick(iso: string, windowMinutes: number): string {
  const d = new Date(iso);
  if (windowMinutes > 1440) {
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function DistributionRow({
  title,
  dist,
  minSamples,
}: {
  title: string;
  dist?: LatencyDistribution;
  minSamples: number;
}) {
  const sampleCount = dist?.sampleCount ?? 0;
  const insufficient = sampleCount > 0 && sampleCount < minSamples;

  return (
    <div className="rounded-lg border border-border-subtle bg-canvas/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-200">{title}</span>
        <span className="font-mono text-[11px] text-slate-400">
          {sampleCount} {sampleCount === 1 ? 'sample' : 'samples'}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 font-mono text-xs tabular-nums">
        <div>
          <span className="block text-[10px] uppercase text-slate-500">Avg</span>
          <span className="text-slate-100">{formatMs(dist?.avgMs)}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase text-slate-500">p50</span>
          <span className="text-sky-300">{formatMs(dist?.p50Ms)}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase text-slate-500">p95</span>
          <span className="text-amber-300">{formatMs(dist?.p95Ms)}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase text-slate-500">p99</span>
          <span className="text-rose-300">{formatMs(dist?.p99Ms)}</span>
        </div>
      </div>
      {insufficient && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          Percentiles require at least {minSamples} samples in the selected window.
        </p>
      )}
    </div>
  );
}

export function LatencyPercentilesChart({
  latency,
  timeseries,
  isLoading = false,
}: LatencyPercentilesChartProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
        <Skeleton className="h-44 w-full rounded-lg" />
      </div>
    );
  }

  const minSamples = latency?.minPercentileSamples ?? timeseries?.minPercentileSamples ?? 5;
  const buckets = timeseries?.buckets ?? [];
  const hasDurationPoints = buckets.some(
    (b) => b.avgDurationMs !== null || b.p95DurationMs !== null,
  );
  const hasAnyLatency =
    hasDurationPoints ||
    (latency?.executionDuration.sampleCount ?? 0) > 0 ||
    (latency?.queueWait.sampleCount ?? 0) > 0;

  if (!hasAnyLatency) {
    return (
      <EmptyState
        icon={<Gauge className="h-5 w-5" />}
        title="No latency samples in this window"
        description="Execution duration percentiles (p50/p95/p99) and queue wait times will appear once jobs complete."
      />
    );
  }

  const windowMinutes = timeseries?.windowMinutes ?? latency?.windowMinutes ?? 60;
  const chartData = buckets.map((b) => ({
    label: formatTick(b.bucketStart, windowMinutes),
    bucketStart: b.bucketStart,
    bucketEnd: b.bucketEnd,
    'Avg Duration (ms)': b.avgDurationMs,
    'p95 Duration (ms)': b.p95DurationMs,
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <DistributionRow
          title="Execution Duration"
          dist={latency?.executionDuration}
          minSamples={minSamples}
        />
        <DistributionRow
          title="Initial Queue Wait"
          dist={latency?.queueWait}
          minSamples={minSamples}
        />
        <DistributionRow
          title="Retry Overhead"
          dist={latency?.retryOverhead}
          minSamples={minSamples}
        />
        <DistributionRow
          title="End-to-End Completion"
          dist={latency?.endToEnd}
          minSamples={minSamples}
        />
      </div>

      {hasDurationPoints ? (
        <div className="h-44 w-full" role="img" aria-label="Execution duration trend chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(148,163,184,0.12)"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                minTickGap={24}
                tick={{ fill: '#94A3B8', fontSize: 11 }}
                axisLine={{ stroke: 'rgba(148,163,184,0.16)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#94A3B8', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                unit="ms"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#161F30',
                  borderColor: 'rgba(148,163,184,0.22)',
                  borderRadius: '0.5rem',
                  fontSize: '12px',
                  color: '#F1F5F9',
                }}
                formatter={(value) => (value === null || value === undefined ? '—' : `${value}ms`)}
              />
              <Legend wrapperStyle={{ fontSize: '11px', color: '#94A3B8' }} />
              <Line
                type="monotone"
                dataKey="Avg Duration (ms)"
                stroke="#38BDF8"
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95 Duration (ms)"
                stroke="#FBBF24"
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-center text-xs text-slate-500">
          Per-bucket duration trend will populate as terminal job durations are recorded.
        </p>
      )}
    </div>
  );
}

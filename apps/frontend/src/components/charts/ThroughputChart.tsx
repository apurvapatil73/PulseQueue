import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity } from 'lucide-react';
import type { OrganisationTimeseriesView } from '../../types/api';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

interface ThroughputChartProps {
  timeseries?: OrganisationTimeseriesView;
  isLoading?: boolean;
}

function formatBucketTick(iso: string, windowMinutes: number): string {
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

export function ThroughputChart({ timeseries, isLoading = false }: ThroughputChartProps) {
  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-lg" />;
  }

  const buckets = timeseries?.buckets ?? [];
  const hasActivity = buckets.some(
    (b) => b.submitted > 0 || b.completed > 0 || b.failed > 0 || b.retries > 0,
  );

  if (buckets.length === 0 || !hasActivity) {
    return (
      <EmptyState
        icon={<Activity className="h-5 w-5" />}
        title="No throughput recorded in this window"
        description="Submitted, completed, and failed job volumes will chart chronologically as jobs execute."
      />
    );
  }

  const windowMinutes = timeseries?.windowMinutes ?? 60;
  const chartData = buckets.map((b) => ({
    label: formatBucketTick(b.bucketStart, windowMinutes),
    bucketStart: b.bucketStart,
    bucketEnd: b.bucketEnd,
    Completed: b.completed,
    Failed: b.failed,
    Submitted: b.submitted,
    Retries: b.retries,
  }));

  return (
    <div className="h-64 w-full" role="img" aria-label="Job throughput over time chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="pqCompletedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#34D399" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#34D399" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="pqFailedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#FB7185" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#FB7185" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" vertical={false} />
          <XAxis
            dataKey="label"
            minTickGap={24}
            tick={{ fill: '#94A3B8', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(148,163,184,0.16)' }}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: '#94A3B8', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#161F30',
              borderColor: 'rgba(148,163,184,0.22)',
              borderRadius: '0.5rem',
              fontSize: '12px',
              color: '#F1F5F9',
            }}
            labelFormatter={(_label, payload) => {
              const item = payload?.[0]?.payload as
                { bucketStart?: string; bucketEnd?: string } | undefined;
              if (!item?.bucketStart || !item?.bucketEnd) return String(_label);
              return `${new Date(item.bucketStart).toISOString().slice(11, 16)}–${new Date(item.bucketEnd).toISOString().slice(11, 16)} UTC`;
            }}
          />
          <Legend wrapperStyle={{ fontSize: '11px', color: '#94A3B8' }} />
          <Area
            type="monotone"
            dataKey="Completed"
            stroke="#34D399"
            strokeWidth={2}
            fill="url(#pqCompletedGrad)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="Failed"
            stroke="#FB7185"
            strokeWidth={2}
            fill="url(#pqFailedGrad)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="Submitted"
            stroke="#38BDF8"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

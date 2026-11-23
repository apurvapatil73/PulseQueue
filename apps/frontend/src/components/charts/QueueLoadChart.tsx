import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Layers } from 'lucide-react';
import type { QueueMetricsItem } from '../../types/api';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

interface QueueLoadChartProps {
  queues?: QueueMetricsItem[];
  isLoading?: boolean;
}

export function QueueLoadChart({ queues, isLoading = false }: QueueLoadChartProps) {
  if (isLoading) {
    return <Skeleton className="h-56 w-full rounded-lg" />;
  }

  if (!queues || queues.length === 0) {
    return (
      <EmptyState
        icon={<Layers className="h-5 w-5" />}
        title="No queues configured"
        description="Create a queue in this organisation to monitor per-queue load and completion volume."
      />
    );
  }

  const data = queues.slice(0, 8).map((q) => ({
    name: q.name.length > 16 ? `${q.name.slice(0, 14)}…` : q.name,
    Completed: q.byStatus.COMPLETED,
    Active: q.byStatus.ACTIVE,
    Queued: q.byStatus.PENDING + q.byStatus.DELAYED,
    Failed: q.byStatus.FAILED,
  }));

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.12)" vertical={false} />
          <XAxis
            dataKey="name"
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
            cursor={{ fill: 'rgba(148,163,184,0.06)' }}
            contentStyle={{
              backgroundColor: '#161F30',
              borderColor: 'rgba(148,163,184,0.2)',
              borderRadius: '0.5rem',
              fontSize: '12px',
              color: '#F1F5F9',
            }}
          />
          <Legend wrapperStyle={{ fontSize: '11px', color: '#94A3B8' }} />
          <Bar dataKey="Completed" stackId="a" fill="#34D399" maxBarSize={36} />
          <Bar dataKey="Active" stackId="a" fill="#38BDF8" maxBarSize={36} />
          <Bar dataKey="Queued" stackId="a" fill="#FBBF24" maxBarSize={36} />
          <Bar dataKey="Failed" stackId="a" fill="#FB7185" radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import type { OrganisationMetricsView } from '../../types/api';
import { EmptyState } from '../ui/EmptyState';
import { Skeleton } from '../ui/Skeleton';

interface JobStatusChartProps {
  summary?: OrganisationMetricsView['summary'];
  isLoading?: boolean;
}

const STATUS_BARS = [
  { key: 'succeeded', label: 'Completed', color: '#34D399' },
  { key: 'active', label: 'Active', color: '#38BDF8' },
  { key: 'pending', label: 'Pending', color: '#FBBF24' },
  { key: 'delayed', label: 'Delayed', color: '#A78BFA' },
  { key: 'paused', label: 'Paused', color: '#94A3B8' },
  { key: 'failed', label: 'Failed', color: '#FB7185' },
] as const;

export function JobStatusChart({ summary, isLoading = false }: JobStatusChartProps) {
  if (isLoading) {
    return <Skeleton className="h-56 w-full rounded-lg" />;
  }

  if (!summary || summary.totalSubmitted === 0) {
    return (
      <EmptyState
        icon={<BarChart3 className="h-5 w-5" />}
        title="No job executions recorded"
        description="Submit jobs to an organisation queue to see real-time status distribution here."
      />
    );
  }

  const data = STATUS_BARS.map((item) => ({
    name: item.label,
    count: summary[item.key],
    color: item.color,
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
          <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={38}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

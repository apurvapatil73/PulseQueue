import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Clock, Cpu, Gauge, Layers, ShieldCheck } from 'lucide-react';
import { useOrganisationSchedulerMetrics } from '../../hooks/useMonitoring';
import type { OrganisationSchedulerMetricsView, SchedulingPolicy } from '../../types/api';
import { Card, CardContent, CardHeader } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ErrorState } from '../ui/ErrorState';
import { MetricCard } from '../ui/MetricCard';
import { Select } from '../ui/Select';
import { StatusBadge } from '../ui/StatusBadge';

export interface SchedulerObservabilitySectionProps {
  organisationId: string | null;
  windowMinutes: number;
  /** Optional injected data/state for isolated unit tests. */
  overrideState?: {
    data?: OrganisationSchedulerMetricsView;
    isLoading?: boolean;
    isError?: boolean;
    errorMessage?: string;
  };
}

const REFRESH_OPTIONS = [
  { label: 'Auto-refresh: Off', value: '0' },
  { label: 'Auto-refresh: 15s', value: '15000' },
  { label: 'Auto-refresh: 30s', value: '30000' },
  { label: 'Auto-refresh: 60s', value: '60000' },
];

const POLICY_LABELS: Record<SchedulingPolicy, string> = {
  LEGACY_BULLMQ: 'Legacy BullMQ',
  FIFO: 'FIFO',
  STRICT_PRIORITY: 'Strict Priority',
  PRIORITY_AGING: 'Priority Aging',
};

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function SchedulerObservabilitySection({
  organisationId,
  windowMinutes,
  overrideState,
}: SchedulerObservabilitySectionProps) {
  const [refreshMs, setRefreshMs] = useState<string>('0');
  const parsedInterval = Number(refreshMs);

  const query = useOrganisationSchedulerMetrics(
    overrideState ? null : organisationId,
    windowMinutes,
    { refetchInterval: parsedInterval > 0 ? parsedInterval : false },
  );

  const isLoading = overrideState?.isLoading ?? query.isLoading;
  const isError = overrideState?.isError ?? query.isError;
  const errorMessage =
    overrideState?.errorMessage ??
    (query.error instanceof Error ? query.error.message : 'Unable to load scheduler metrics.');
  const data = overrideState?.data ?? query.data;

  if (isLoading) {
    return (
      <Card className="mt-6">
        <CardHeader title="Scheduler Observability" description="Loading scheduler telemetry…" />
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <div className="mt-6">
        <ErrorState
          title="Scheduler telemetry unavailable"
          message={errorMessage}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const totalQueues = data.policyDistribution.reduce((sum, p) => sum + p.queueCount, 0);
  const priorityChartData = [
    { tier: 'Critical (16–20)', count: data.backlogByPriority.byTier.critical },
    { tier: 'High (11–15)', count: data.backlogByPriority.byTier.high },
    { tier: 'Medium (6–10)', count: data.backlogByPriority.byTier.medium },
    { tier: 'Low (1–5)', count: data.backlogByPriority.byTier.low },
  ];
  const totalPendingByPriority = priorityChartData.reduce((sum, d) => sum + d.count, 0);

  const healthTone =
    data.schedulerHealth.status === 'healthy'
      ? 'emerald'
      : data.schedulerHealth.status === 'degraded'
        ? 'rose'
        : 'slate';

  return (
    <section aria-label="Scheduler Observability" className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold text-slate-100">
            Priority Scheduler &amp; Capacity
          </h2>
          <StatusBadge
            status={data.schedulerHealth.status.toUpperCase()}
            label={`Scheduler: ${data.schedulerHealth.status}`}
            tone={healthTone}
            showDot
          />
        </div>
        <div className="w-48">
          <Select
            aria-label="Scheduler auto-refresh interval"
            value={refreshMs}
            onChange={(e) => setRefreshMs(e.target.value)}
            options={REFRESH_OPTIONS}
          />
        </div>
      </div>

      {/* Top KPI Row: Backlog, Dispatch Latency, Starvation, Tenant Capacity */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Eligible Queued Backlog"
          value={data.backlog.eligibleQueued}
          subtext={`Delayed: ${data.backlog.delayed} · In-flight dispatch: ${data.backlog.dispatching}`}
          icon={<Layers className="h-4 w-4 text-sky-400" />}
        />
        <MetricCard
          label="Dispatch Latency (Avg / p95)"
          value={`${fmtMs(data.dispatchLatency.avgMs)} / ${fmtMs(data.dispatchLatency.p95Ms)}`}
          subtext={`p50: ${fmtMs(data.dispatchLatency.p50Ms)} · p99: ${fmtMs(data.dispatchLatency.p99Ms)} (${data.dispatchLatency.sampleCount} samples)`}
          icon={<Clock className="h-4 w-4 text-indigo-400" />}
        />
        <MetricCard
          label="Starvation & Stale Claims"
          value={data.backlog.starvedEligibleCount}
          subtext={`Oldest eligible: ${fmtMs(data.backlog.oldestEligibleAgeMs)} · Stale claims: ${data.backlog.staleReservationsActive}`}
          icon={
            <AlertTriangle
              className={`h-4 w-4 ${
                data.backlog.starvedEligibleCount > 0 || data.backlog.staleReservationsActive > 0
                  ? 'text-rose-400'
                  : 'text-emerald-400'
              }`}
            />
          }
        />
        <MetricCard
          label="Tenant Capacity Utilization"
          value={
            data.tenantCapacity.utilizationPercent !== null
              ? `${data.tenantCapacity.utilizationPercent}%`
              : `${data.tenantCapacity.reservedTotal} reserved`
          }
          subtext={
            data.tenantCapacity.maxActiveJobs !== null
              ? `${data.tenantCapacity.reservedTotal} / ${data.tenantCapacity.maxActiveJobs} maxActiveJobs · Workers: ${data.workerCapacity.workerUtilizationPercent ?? 0}%`
              : `No org maxActiveJobs cap · Workers: ${data.workerCapacity.onlineWorkers} online (${data.workerCapacity.jobsPerSecond}/s)`
          }
          icon={<Gauge className="h-4 w-4 text-emerald-400" />}
        />
      </div>

      {/* Policy Distribution + Backlog by Priority */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Scheduling Policy Distribution"
            description="Configured queues and eligible backlog by scheduling policy"
          />
          <CardContent>
            {totalQueues === 0 ? (
              <EmptyState
                title="No queues configured"
                description="Create a queue to view scheduling policy distribution."
              />
            ) : (
              <div className="space-y-3">
                {data.policyDistribution.map((entry) => {
                  const pct =
                    totalQueues > 0 ? Math.round((entry.queueCount / totalQueues) * 100) : 0;
                  return (
                    <div key={entry.policy} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-200">
                          {POLICY_LABELS[entry.policy]}
                        </span>
                        <span className="font-mono text-slate-400">
                          {entry.queueCount} queues ({pct}%) · {entry.eligibleQueuedJobs} queued ·{' '}
                          {entry.delayedJobs} delayed
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-sky-500/80 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Backlog by Priority Tier"
            description="Current pending jobs grouped by priority band"
          />
          <CardContent>
            {totalPendingByPriority === 0 ? (
              <EmptyState
                title="No pending backlog"
                description="All priority tiers currently have zero pending jobs."
              />
            ) : (
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={priorityChartData}
                    margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="tier" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0f172a',
                        borderColor: '#334155',
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="count" name="Pending Jobs" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Queue Wait-Time by Priority Tier + Worker & Scheduler Health */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Queue Wait Time by Priority Tier"
            description={`Windowed wait time from readyAt to first start (last ${data.windowMinutes}m)`}
          />
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2 pr-3 font-medium">Tier</th>
                    <th className="py-2 pr-3 text-right font-medium">Samples</th>
                    <th className="py-2 pr-3 text-right font-medium">Avg</th>
                    <th className="py-2 pr-3 text-right font-medium">p50</th>
                    <th className="py-2 pr-3 text-right font-medium">p95</th>
                    <th className="py-2 text-right font-medium">p99 / Max</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                  {data.waitTimeByPriorityTier.map((row) => (
                    <tr key={row.tier}>
                      <td className="py-2 pr-3 font-sans capitalize text-slate-200">{row.tier}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{row.sampleCount}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{fmtMs(row.avgMs)}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{fmtMs(row.p50Ms)}</td>
                      <td className="py-2 pr-3 text-right text-slate-300">{fmtMs(row.p95Ms)}</td>
                      <td className="py-2 text-right text-slate-300">
                        {fmtMs(row.p99Ms)} / {fmtMs(row.maxMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Worker Capacity &amp; Scheduler Health"
            description="Tenant worker capacity alongside process-level aggregate scheduler counters"
          />
          <CardContent className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <Cpu className="h-3.5 w-3.5 text-sky-400" />
                  <span>Worker Utilization</span>
                </div>
                <div className="mt-1 font-mono text-sm font-semibold text-slate-100">
                  {data.workerCapacity.workerUtilizationPercent !== null
                    ? `${data.workerCapacity.workerUtilizationPercent}%`
                    : '—'}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {data.workerCapacity.activeJobs} active /{' '}
                  {data.workerCapacity.configuredConcurrency} slots (
                  {data.workerCapacity.availableWorkerCapacity} free)
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <div className="flex items-center gap-1.5 text-slate-400">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Throughput &amp; Exec</span>
                </div>
                <div className="mt-1 font-mono text-sm font-semibold text-slate-100">
                  {data.workerCapacity.jobsPerSecond} jobs/s
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  Avg exec: {fmtMs(data.workerCapacity.avgExecutionDurationMs)} · Tick:{' '}
                  {fmtMs(data.schedulerHealth.lastTickDurationMs)}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-800/80 bg-slate-900/40 p-2.5 font-mono text-[11px] text-slate-300">
              <div>Claims: {data.schedulerHealth.processCounters.claimsTotal}</div>
              <div>Dispatches: {data.schedulerHealth.processCounters.dispatchesTotal}</div>
              <div>Failures: {data.schedulerHealth.processCounters.dispatchFailuresTotal}</div>
              <div>
                Starved Promos: {data.schedulerHealth.processCounters.starvationPromotionsTotal}
              </div>
              <div>
                Recoveries: {data.schedulerHealth.processCounters.reservationRecoveriesTotal}
              </div>
              <div>
                Cap Denials: {data.schedulerHealth.processCounters.tenantCapacityDenialsTotal}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

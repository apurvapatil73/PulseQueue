export type BadgeTone = 'emerald' | 'sky' | 'amber' | 'rose' | 'slate' | 'indigo';

const TONE_STYLES: Record<BadgeTone, string> = {
  emerald: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
  sky: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
  amber: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
  rose: 'bg-rose-500/12 text-rose-300 border-rose-500/25',
  indigo: 'bg-indigo-500/12 text-indigo-300 border-indigo-500/25',
  slate: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
};

const DOT_STYLES: Record<BadgeTone, string> = {
  emerald: 'bg-emerald-400',
  sky: 'bg-sky-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
  indigo: 'bg-indigo-400',
  slate: 'bg-slate-400',
};

export function inferStatusTone(status: string): BadgeTone {
  const normalized = status.toUpperCase();
  if (
    [
      'COMPLETED',
      'ONLINE',
      'ACTIVE',
      'OK',
      'CONNECTED',
      'DISPATCHED',
      'ACCEPTED',
      'JOB_COMPLETED',
      'JOB_RECOVERED',
      'WORKER_STARTED',
    ].includes(normalized)
  ) {
    return 'emerald';
  }
  if (
    [
      'PENDING',
      'DELAYED',
      'PAUSED',
      'DEGRADED',
      'SCHEDULED',
      'MISSED',
      'SKIPPED_OVERLAP',
      'SKIPPED_CONCURRENCY',
      'SKIPPED_MIN_INTERVAL',
      'SKIPPED_MAX_RUNS',
      'JOB_RETRIED',
      'JOB_STALLED',
    ].includes(normalized)
  ) {
    return 'amber';
  }
  if (
    [
      'FAILED',
      'STALE',
      'ERROR',
      'DISCONNECTED',
      'OPEN',
      'CANCELLED',
      'REVOKED',
      'EXPIRED',
      'JOB_FAILED',
      'JOB_MOVED_TO_DLQ',
      'WORKER_HEARTBEAT_STALE',
    ].includes(normalized)
  ) {
    return 'rose';
  }
  if (
    [
      'OWNER',
      'REPLAYED',
      'CATCH_UP',
      'FIRE_ONCE',
      'JOB_SUBMITTED',
      'JOB_STARTED',
      'JOB_REPLAYED',
      'RECURRING',
    ].includes(normalized)
  ) {
    return 'sky';
  }
  if (['ADMIN', 'ONE_TIME'].includes(normalized)) {
    return 'indigo';
  }
  return 'slate';
}

export function StatusBadge({
  status,
  label,
  tone,
  showDot = false,
}: {
  status: string;
  label?: string;
  tone?: BadgeTone;
  showDot?: boolean;
}) {
  const resolvedTone = tone ?? inferStatusTone(status);
  const text = label ?? status.replace(/_/g, ' ');

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase ${TONE_STYLES[resolvedTone]}`}
    >
      {showDot && <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[resolvedTone]}`} />}
      {text}
    </span>
  );
}

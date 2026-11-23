import { JobStatus } from '@prisma/client';
import { ConflictError } from './errors.js';

/**
 * Valid job lifecycle transitions based on the persisted JobStatus enum.
 * Lifecycle transitions are enforced strictly inside trusted service logic;
 * no public HTTP endpoint permits arbitrary status mutation.
 */
export const ALLOWED_JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  [JobStatus.PENDING]: [JobStatus.ACTIVE, JobStatus.PAUSED, JobStatus.DELAYED, JobStatus.FAILED],
  [JobStatus.DELAYED]: [JobStatus.PENDING, JobStatus.ACTIVE, JobStatus.PAUSED, JobStatus.FAILED],
  [JobStatus.PAUSED]: [JobStatus.PENDING, JobStatus.DELAYED],
  [JobStatus.ACTIVE]: [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.DELAYED],
  [JobStatus.FAILED]: [JobStatus.PENDING, JobStatus.DELAYED],
  [JobStatus.COMPLETED]: [], // Terminal state — no outgoing transitions
};

/**
 * Terminal states that must never be overwritten by stale or duplicated workers.
 */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  JobStatus.COMPLETED,
  JobStatus.FAILED,
]);

/**
 * Pre-execution job states that can be safely cancelled before a worker picks them up.
 */
export const CANCELLABLE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  JobStatus.PENDING,
  JobStatus.DELAYED,
  JobStatus.PAUSED,
]);

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_JOB_TRANSITIONS[from].includes(to);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function assertValidJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJobStatus(from, to)) {
    throw new ConflictError(`Invalid job status transition from ${from} to ${to}`, {
      from,
      to,
      allowedTransitions: ALLOWED_JOB_TRANSITIONS[from],
    });
  }
}

export function isCancellableJobStatus(status: JobStatus): boolean {
  return CANCELLABLE_JOB_STATUSES.has(status);
}

/**
 * Computes the deterministic initial persisted status for a newly submitted job.
 * Never pretends a job is ACTIVE or COMPLETED without an executing worker.
 */
export function resolveInitialJobStatus(options: {
  queueIsPaused: boolean;
  delayMs: number;
}): JobStatus {
  if (options.queueIsPaused) {
    return JobStatus.PAUSED;
  }
  if (options.delayMs > 0) {
    return JobStatus.DELAYED;
  }
  return JobStatus.PENDING;
}

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export type JobStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'DELAYED' | 'PAUSED';

export type WorkerHealthStatus = 'ONLINE' | 'DEGRADED' | 'STALE' | 'STOPPED';

export type ScheduleType = 'ONE_TIME' | 'RECURRING';

export type ScheduleStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export type MisfirePolicy = 'SKIP_MISSED' | 'FIRE_ONCE' | 'CATCH_UP';

export type PlatformEventType =
  | 'JOB_SUBMITTED'
  | 'JOB_STARTED'
  | 'JOB_COMPLETED'
  | 'JOB_FAILED'
  | 'JOB_RETRIED'
  | 'JOB_STALLED'
  | 'JOB_RECOVERED'
  | 'JOB_MOVED_TO_DLQ'
  | 'JOB_REPLAYED'
  | 'WORKER_STARTED'
  | 'WORKER_STOPPED'
  | 'WORKER_HEARTBEAT_STALE';

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, string[] | undefined>;
  };
  timestamp: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganisationView {
  id: string;
  name: string;
  role?: OrgRole;
  createdAt: string;
  updatedAt: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  services: {
    database: 'connected' | 'disconnected';
    redis: 'connected' | 'disconnected';
  };
  timestamp: string;
}

export interface QueueMetricsItem {
  queueId: string;
  name: string;
  isPaused: boolean;
  concurrency: number;
  totalJobs: number;
  byStatus: Record<JobStatus, number>;
  averageDurationMs: number | null;
  openDeadLetters: number;
}

export interface OrgSafeWorkerView {
  workerInstanceId: string;
  hostname: string;
  pid: number;
  status: WorkerHealthStatus;
  registeredQueues: string[];
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  lastError: string | null;
  lastHeartbeatAt: string;
  startedAt: string;
  stoppedAt: string | null;
  heartbeatAgeMs: number;
}

export interface OrganisationMetricsView {
  organisationId: string;
  summary: {
    totalSubmitted: number;
    totalProcessed: number;
    succeeded: number;
    failed: number;
    active: number;
    pending: number;
    delayed: number;
    paused: number;
    retriedJobs: number;
    totalRetryEvents: number;
    stalledRecoveries: number;
    deadLetterOpen: number;
    deadLetterReplayed: number;
    averageDurationMs: number | null;
  };
  throughput: {
    windowMinutes: number;
    completedInWindow: number;
    failedInWindow: number;
    processedInWindow: number;
    jobsPerMinute: number;
  };
  queues: QueueMetricsItem[];
  workers: OrgSafeWorkerView[];
  generatedAt: string;
}

export interface PlatformEventView {
  id: string;
  type: PlatformEventType;
  organisationId: string | null;
  queueId: string | null;
  jobId: string | null;
  workerId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ScheduleSummaryView {
  id: string;
  organisationId: string;
  queueId: string;
  queueName: string;
  name: string;
  description: string | null;
  type: ScheduleType;
  status: ScheduleStatus;
  jobName: string;
  cronExpression: string | null;
  timezone: string;
  runAt: string | null;
  nextRunAt: string | null;
  nextRunAtLocal: string | null;
  lastRunAt: string | null;
  runCount: number;
  preventOverlap: boolean;
  misfirePolicy: MisfirePolicy;
  createdAt: string;
  updatedAt: string;
}

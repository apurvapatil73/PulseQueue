export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export type AssignableMemberRole = 'ADMIN' | 'MEMBER';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export type JobStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'DELAYED' | 'PAUSED';

export type DeadLetterStatus = 'OPEN' | 'REPLAYED';

export type WorkerHealthStatus = 'ONLINE' | 'DEGRADED' | 'STALE' | 'STOPPED';

export type ScheduleType = 'ONE_TIME' | 'RECURRING';

export type ScheduleStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export type MisfirePolicy = 'SKIP_MISSED' | 'FIRE_ONCE' | 'CATCH_UP';

export type ScheduleExecutionStatus =
  | 'SCHEDULED'
  | 'DISPATCHED'
  | 'MISSED'
  | 'SKIPPED_OVERLAP'
  | 'SKIPPED_CONCURRENCY'
  | 'SKIPPED_MIN_INTERVAL'
  | 'SKIPPED_MAX_RUNS'
  | 'CANCELLED';

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

export interface MemberView {
  id: string;
  role: OrgRole;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

export interface InvitationView {
  id: string;
  organisationId: string;
  invitedEmail: string;
  role: OrgRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  invitedBy: {
    id: string;
    name: string;
    email: string;
  };
}

export interface CreateInvitationPayload {
  email: string;
  role: AssignableMemberRole;
}

export interface CreateInvitationResult {
  invitation: InvitationView;
  token?: string;
}

export interface TransferOwnershipResult {
  organisationId: string;
  newOwnerId: string;
  previousOwnerId: string;
}

export interface AcceptInvitationResult {
  organisationId: string;
  role: OrgRole;
  membershipId: string;
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

export interface QueueView {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  isPaused: boolean;
  pausedAt: string | null;
  concurrency: number;
  defaultPriority: number;
  maxRetries: number;
  backoffMs: number;
  jobCount: number;
  createdBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueStatsView {
  queueId: string;
  organisationId: string;
  name: string;
  isPaused: boolean;
  pausedAt: string | null;
  config: {
    concurrency: number;
    defaultPriority: number;
    maxRetries: number;
    backoffMs: number;
  };
  jobs: {
    total: number;
    byStatus: Record<JobStatus, number>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface JobView {
  id: string;
  queueId: string;
  queueName: string;
  organisationId: string;
  name: string;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown> | unknown;
  maxRetries: number;
  backoffMs: number;
  delayMs: number;
  attemptsMade: number;
  stalledCount: number;
  durationMs: number | null;
  lastWorkerId: string | null;
  replayedFromDlqId: string | null;
  result: Record<string, unknown> | unknown | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastRecoveredAt: string | null;
  createdBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueDispatchInfo {
  enqueued: boolean;
  deduplicated: boolean;
  bullmqJobId: string | null;
  bullmqQueueName: string;
  error?: string;
}

export interface JobSubmissionResult {
  job: JobView;
  dispatch: EnqueueDispatchInfo;
}

export interface CancelJobResult {
  cancelled: true;
  jobId: string;
  queueId: string;
  organisationId: string;
  previousStatus: JobStatus;
  message: string;
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

export interface ScheduleView extends ScheduleSummaryView {
  payload: Record<string, unknown> | unknown;
  priority: number | null;
  maxRetries: number | null;
  backoffMs: number | null;
  lastDispatchedAt: string | null;
  maxCatchUpRuns: number;
  misfireGraceMs: number;
  maxConcurrentRuns: number | null;
  maxTotalRuns: number | null;
  maxDurationMs: number | null;
  minIntervalMs: number | null;
  createdBy: {
    id: string;
    name: string;
    email: string;
  } | null;
}

export interface CreateSchedulePayload {
  queueId: string;
  name: string;
  description?: string | null;
  type: ScheduleType;
  jobName: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  backoffMs?: number;
  timezone?: string;
  runAt?: string;
  cronExpression?: string;
  preventOverlap?: boolean;
  misfirePolicy?: MisfirePolicy;
  maxCatchUpRuns?: number;
  misfireGraceMs?: number;
  maxConcurrentRuns?: number | null;
  maxTotalRuns?: number | null;
  maxDurationMs?: number | null;
  minIntervalMs?: number | null;
}

export interface UpdateSchedulePayload {
  name?: string;
  description?: string | null;
  jobName?: string;
  payload?: Record<string, unknown>;
  priority?: number | null;
  maxRetries?: number | null;
  backoffMs?: number | null;
  timezone?: string;
  runAt?: string;
  cronExpression?: string;
  preventOverlap?: boolean;
  misfirePolicy?: MisfirePolicy;
  maxCatchUpRuns?: number;
  misfireGraceMs?: number;
  maxConcurrentRuns?: number | null;
  maxTotalRuns?: number | null;
  maxDurationMs?: number | null;
  minIntervalMs?: number | null;
}

export interface CreateScheduleResult {
  schedule: ScheduleView;
  initialJobId?: string;
  dispatch?: EnqueueDispatchInfo;
}

export interface PaginatedSchedulesView {
  schedules: ScheduleView[];
  pagination: PaginationMeta;
}

export interface ScheduleExecutionJobSummary {
  id: string;
  status: JobStatus;
  priority: number;
  attemptsMade: number;
  durationMs: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface ScheduleExecutionView {
  id: string;
  scheduleId: string;
  jobId: string | null;
  scheduledFor: string;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finalJobStatus: JobStatus | null;
  retryCount: number;
  durationMs: number | null;
  isCatchUp: boolean;
  status: ScheduleExecutionStatus;
  reason: string | null;
  job: ScheduleExecutionJobSummary | null;
  createdAt: string;
}

export interface PaginatedScheduleExecutionsView {
  executions: ScheduleExecutionView[];
  pagination: PaginationMeta;
}

export interface NextRunPreviewView {
  scheduleId: string;
  type: ScheduleType;
  status: ScheduleStatus;
  timezone: string;
  cronExpression: string | null;
  nextRunAt: string | null;
  nextRunAtLocal: string | null;
  upcomingRuns: Array<{
    utc: string;
    local: string;
  }>;
}

export interface ScheduleStatsView {
  scheduleId: string;
  name: string;
  type: ScheduleType;
  status: ScheduleStatus;
  misfirePolicy: MisfirePolicy;
  runCount: number;
  maxTotalRuns: number | null;
  remainingRuns: number | null;
  currentInFlight: number;
  totalExecutions: number;
  catchUpExecutions: number;
  byStatus: {
    scheduled: number;
    dispatched: number;
    missed: number;
    skippedOverlap: number;
    skippedConcurrency: number;
    skippedMinInterval: number;
    skippedMaxRuns: number;
    cancelled: number;
  };
  byFinalJobStatus: {
    completed: number;
    failed: number;
    inFlight: number;
  };
  totalRetries: number;
  durationMs: {
    avg: number | null;
    min: number | null;
    max: number | null;
  };
  lastRunAt: string | null;
  lastDispatchedAt: string | null;
  nextRunAt: string | null;
}

export interface ScheduleBullMQReconcileSummary {
  scanned: number;
  reEnqueued: number;
  alreadyPresent: number;
  failed: number;
}

export interface ScheduleTickSummary {
  scanned: number;
  dispatched: number;
  catchUpDispatched: number;
  missedRecorded: number;
  skippedOverlap: number;
  skippedConcurrency: number;
  skippedMinInterval: number;
  skippedMaxRuns: number;
  skippedContention: number;
  completedOneTime: number;
  completedMaxRuns: number;
  outboxDeferred: number;
}

export interface ReconcileSchedulesResult {
  bullmq: ScheduleBullMQReconcileSummary;
  tick: ScheduleTickSummary;
}

export interface DeadLetterPayloadSummary {
  keyCount: number;
  keys: string[];
  byteLength: number;
}

export interface DeadLetterJobView {
  id: string;
  originalJobId: string;
  organisationId: string;
  queueId: string;
  queueName: string;
  jobName: string;
  payloadSummary: DeadLetterPayloadSummary | Record<string, unknown> | unknown;
  failureReason: string;
  attemptsMade: number;
  maxRetries: number;
  status: DeadLetterStatus;
  failedAt: string;
  replayedAt: string | null;
  replayedById: string | null;
  replayedJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedDlqView {
  items: DeadLetterJobView[];
  pagination: PaginationMeta;
}

export interface ReplayDlqPayload {
  payload?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface ReplayedJobSummaryView {
  id: string;
  queueId: string;
  organisationId: string;
  name: string;
  status: JobStatus;
  priority: number;
  replayedFromDlqId: string | null;
  createdAt: string;
}

export interface ReplayDlqResult {
  deadLetterJob: DeadLetterJobView;
  replayedJob: ReplayedJobSummaryView;
  dispatch: EnqueueDispatchInfo;
}

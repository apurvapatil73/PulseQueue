/**
 * PulseQueue Shared Types and Contracts
 * Central repository for cross-cutting types, enums, and interfaces
 * shared between Backend, Worker, and Frontend applications.
 */

export enum JobStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DELAYED = 'delayed',
  PAUSED = 'paused',
}

export enum JobPriority {
  LOW = 1,
  NORMAL = 5,
  HIGH = 10,
  CRITICAL = 20,
}

export enum QueueName {
  DEFAULT = 'pulsequeue:default',
  HIGH_PRIORITY = 'pulsequeue:high-priority',
  SCHEDULED = 'pulsequeue:scheduled',
  DEAD_LETTER = 'pulsequeue:dead-letter',
}

export enum WorkflowStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface JobDefinition<TData = unknown> {
  id: string;
  name: string;
  queue: QueueName | string;
  data: TData;
  priority?: JobPriority;
  status: JobStatus;
  progress?: number;
  attemptsMade: number;
  maxAttempts: number;
  backoffMs?: number;
  createdAt: Date;
  updatedAt: Date;
  processedOn?: Date;
  finishedOn?: Date;
  failedReason?: string;
}

export interface JobResult<TResult = unknown> {
  jobId: string;
  success: boolean;
  result?: TResult;
  error?: string;
  executionDurationMs: number;
  completedAt: Date;
}

export interface PlatformHealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  services: {
    postgres: boolean;
    redis: boolean;
  };
}

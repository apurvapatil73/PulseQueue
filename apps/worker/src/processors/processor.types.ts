import type { Prisma } from '@prisma/client';

/**
 * Context supplied to a job processor during execution.
 * Kept strictly decoupled from BullMQ internals.
 */
export interface ProcessorContext {
  jobId: string;
  organisationId: string;
  queueId: string;
  queueName: string;
  jobName: string;
  payload: unknown;
  attemptNumber: number;
  maxAttempts: number;
}

/**
 * Structured deterministic result returned by a processor and persisted to PostgreSQL.
 */
export interface ProcessorResult {
  processor: string;
  output: Prisma.InputJsonValue;
  durationMs: number;
}

export interface JobProcessor {
  /** Unique processor name matching submitted job `name`. */
  readonly name: string;
  readonly description: string;
  /**
   * Validates the payload and executes a deterministic, safe operation.
   * Must NEVER execute arbitrary code or shell commands from user payloads.
   */
  execute(context: ProcessorContext): Promise<Prisma.InputJsonValue>;
}

/**
 * Thrown when payload validation fails before execution.
 * Treated as non-retryable by default because retrying invalid input will always fail.
 */
export class InvalidJobPayloadError extends Error {
  public readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobPayloadError';
  }
}

/**
 * Thrown when no processor is registered for the submitted job name.
 */
export class UnregisteredProcessorError extends Error {
  public readonly retryable = false;

  constructor(jobName: string) {
    super(`No job processor registered for job name "${jobName}"`);
    this.name = 'UnregisteredProcessorError';
  }
}

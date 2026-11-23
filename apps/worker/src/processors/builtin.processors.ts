import crypto from 'node:crypto';
import { z } from 'zod';
import {
  InvalidJobPayloadError,
  type JobProcessor,
  type ProcessorContext,
} from './processor.types.js';
import { ProcessorRegistry } from './processor.registry.js';

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, processorName: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
      .join('; ');
    throw new InvalidJobPayloadError(`Invalid payload for "${processorName}": ${summary}`);
  }
  return parsed.data;
}

const echoPayloadSchema = z.object({
  message: z.string().min(1, 'message must be a non-empty string').max(4096),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/**
 * Built-in safe processor: validates a text message and produces a deterministic
 * echoed output with character length and SHA-256 checksum.
 */
export const echoProcessor: JobProcessor = {
  name: 'echo',
  description: 'Deterministic echo processor with SHA-256 digest verification',
  async execute(context: ProcessorContext) {
    const data = parsePayload(echoPayloadSchema, context.payload, 'echo');
    const digest = crypto.createHash('sha256').update(data.message).digest('hex');

    return {
      echoed: data.message,
      length: data.message.length,
      sha256: digest,
      attemptNumber: context.attemptNumber,
      ...(data.metadata ? { metadata: data.metadata } : {}),
    };
  },
};

const mathSumPayloadSchema = z.object({
  numbers: z
    .array(z.number().finite('all entries must be finite numbers'))
    .min(1, 'numbers must contain at least one number')
    .max(10_000, 'numbers must not exceed 10,000 items'),
});

/**
 * Built-in safe processor: computes deterministic aggregate statistics over an array of numbers.
 */
export const mathSumProcessor: JobProcessor = {
  name: 'math.sum',
  description: 'Computes sum, count, min, max, and average over a numeric array',
  async execute(context: ProcessorContext) {
    const data = parsePayload(mathSumPayloadSchema, context.payload, 'math.sum');
    let sum = 0;
    let min = data.numbers[0];
    let max = data.numbers[0];

    for (const n of data.numbers) {
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }

    return {
      sum,
      count: data.numbers.length,
      min,
      max,
      average: sum / data.numbers.length,
    };
  },
};

const transformJsonPayloadSchema = z.object({
  records: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  uppercaseKeys: z.boolean().optional().default(false),
});

/**
 * Built-in safe processor: deterministically normalizes flat key-value records.
 */
export const transformJsonProcessor: JobProcessor = {
  name: 'transform.json',
  description: 'Deterministically normalizes flat JSON key-value records',
  async execute(context: ProcessorContext) {
    const data = parsePayload(transformJsonPayloadSchema, context.payload, 'transform.json');
    const transformed: Record<string, string | number | boolean | null> = {};

    for (const key of Object.keys(data.records).sort()) {
      const targetKey = data.uppercaseKeys ? key.toUpperCase() : key;
      transformed[targetKey] = data.records[key];
    }

    return {
      keyCount: Object.keys(transformed).length,
      transformed,
    };
  },
};

const testFailPayloadSchema = z.object({
  reason: z.string().min(1).max(500).optional().default('Simulated processor failure'),
  /**
   * When set, fails on attempts <= failUntilAttempt and succeeds on subsequent attempts.
   * Useful for deterministic retry & backoff testing.
   */
  failUntilAttempt: z.number().int().min(1).max(20).optional(),
});

/**
 * Built-in deterministic failure/recovery processor for verifying retry and backoff pipelines.
 */
export const testFailProcessor: JobProcessor = {
  name: 'test.fail',
  description: 'Deterministic failure and transient retry-recovery test processor',
  async execute(context: ProcessorContext) {
    const data = parsePayload(testFailPayloadSchema, context.payload, 'test.fail');

    if (data.failUntilAttempt === undefined || context.attemptNumber <= data.failUntilAttempt) {
      throw new Error(`${data.reason} (attempt ${context.attemptNumber}/${context.maxAttempts})`);
    }

    return {
      recovered: true,
      recoveredOnAttempt: context.attemptNumber,
      maxAttempts: context.maxAttempts,
    };
  },
};

export const BUILTIN_PROCESSORS: readonly JobProcessor[] = [
  echoProcessor,
  mathSumProcessor,
  transformJsonProcessor,
  testFailProcessor,
];

/**
 * Creates a ProcessorRegistry pre-populated with all safe built-in processors.
 */
export function createDefaultProcessorRegistry(): ProcessorRegistry {
  const registry = new ProcessorRegistry();
  for (const processor of BUILTIN_PROCESSORS) {
    registry.register(processor);
  }
  return registry;
}

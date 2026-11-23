import {
  type JobProcessor,
  type ProcessorContext,
  type ProcessorResult,
  UnregisteredProcessorError,
} from './processor.types.js';

/**
 * Extensible registry mapping job names to decoupled, safe job processors.
 * Prevents silent overwriting unless `replace: true` is explicitly passed.
 */
export class ProcessorRegistry {
  private readonly processors = new Map<string, JobProcessor>();

  register(processor: JobProcessor, options?: { replace?: boolean }): this {
    if (this.processors.has(processor.name) && !options?.replace) {
      throw new Error(`Processor "${processor.name}" is already registered`);
    }
    this.processors.set(processor.name, processor);
    return this;
  }

  has(name: string): boolean {
    return this.processors.has(name);
  }

  get(name: string): JobProcessor | undefined {
    return this.processors.get(name);
  }

  list(): string[] {
    return Array.from(this.processors.keys());
  }

  async execute(context: ProcessorContext): Promise<ProcessorResult> {
    const processor = this.processors.get(context.jobName);
    if (!processor) {
      throw new UnregisteredProcessorError(context.jobName);
    }

    const startTime = Date.now();
    const output = await processor.execute(context);
    const durationMs = Math.max(0, Date.now() - startTime);

    return {
      processor: processor.name,
      output,
      durationMs,
    };
  }
}

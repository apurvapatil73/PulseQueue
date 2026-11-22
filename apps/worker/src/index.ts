/**
 * PulseQueue Worker Service
 * Entry point placeholder prepared for Step 2+ implementation (BullMQ processors).
 */
import { QueueName } from '@pulsequeue/shared';

export const WORKER_SERVICE_NAME = 'pulsequeue-worker';

export function getRegisteredQueues(): string[] {
  return [QueueName.DEFAULT, QueueName.HIGH_PRIORITY, QueueName.SCHEDULED];
}

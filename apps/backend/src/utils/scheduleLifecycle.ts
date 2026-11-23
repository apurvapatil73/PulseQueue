import { ScheduleStatus } from '@prisma/client';
import { ConflictError } from './errors.js';

/**
 * Allowed schedule lifecycle state transitions:
 * - ACTIVE    -> PAUSED | COMPLETED | CANCELLED
 * - PAUSED    -> ACTIVE | CANCELLED
 * - COMPLETED -> (terminal)
 * - CANCELLED -> (terminal)
 */
export const ALLOWED_SCHEDULE_TRANSITIONS: Record<ScheduleStatus, readonly ScheduleStatus[]> = {
  [ScheduleStatus.ACTIVE]: [
    ScheduleStatus.PAUSED,
    ScheduleStatus.COMPLETED,
    ScheduleStatus.CANCELLED,
  ],
  [ScheduleStatus.PAUSED]: [ScheduleStatus.ACTIVE, ScheduleStatus.CANCELLED],
  [ScheduleStatus.COMPLETED]: [],
  [ScheduleStatus.CANCELLED]: [],
};

export function isTerminalScheduleStatus(status: ScheduleStatus): boolean {
  return status === ScheduleStatus.COMPLETED || status === ScheduleStatus.CANCELLED;
}

export function canTransitionScheduleStatus(from: ScheduleStatus, to: ScheduleStatus): boolean {
  return ALLOWED_SCHEDULE_TRANSITIONS[from].includes(to);
}

export function assertValidScheduleTransition(
  from: ScheduleStatus,
  to: ScheduleStatus,
  action?: string,
): void {
  if (!canTransitionScheduleStatus(from, to)) {
    const verb = action ? `Cannot ${action}` : `Invalid schedule transition ${from} -> ${to}`;
    throw new ConflictError(`${verb}: schedule is currently in ${from} status`);
  }
}

import { PlatformEventType, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { DEFAULT_EVENT_RETENTION_DAYS } from './eventRetention.service.js';
import {
  DEFAULT_MAX_REPLAY_EVENTS,
  realtimeEventBus,
  sanitizeRealtimeMetadata,
  type RealtimePlatformEvent,
} from './realtime.service.js';
import { metricsService } from './metrics.service.js';

export interface RecordEventInput {
  type: PlatformEventType;
  organisationId?: string | null;
  queueId?: string | null;
  jobId?: string | null;
  workerId?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface EventView {
  id: string;
  type: PlatformEventType;
  organisationId: string | null;
  queueId: string | null;
  jobId: string | null;
  workerId: string | null;
  message: string;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

export interface ListEventsQuery {
  type?: PlatformEventType;
  queueId?: string;
  jobId?: string;
  page: number;
  limit: number;
}

export interface PaginatedEventsView {
  events: EventView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export type ReplayCursorStatus =
  'ok' | 'invalid_cursor' | 'cursor_not_found' | 'cursor_expired' | 'truncated';

export interface ReplayEventsResult {
  status: ReplayCursorStatus;
  events: EventView[];
  truncated: boolean;
}

export function toRealtimePlatformEvent(event: EventView): RealtimePlatformEvent | null {
  if (!event.organisationId) return null;
  return {
    id: event.id,
    type: event.type,
    organisationId: event.organisationId,
    queueId: event.queueId,
    jobId: event.jobId,
    workerId: event.workerId,
    message: event.message,
    metadata: sanitizeRealtimeMetadata(event.metadata),
    createdAt: event.createdAt.toISOString(),
  };
}

const SENSITIVE_META_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'secret',
  'jwt',
  'authorization',
  'payload',
  'rawtoken',
  'apikey',
  'cookie',
]);

function sanitizeMetadata(input?: Record<string, unknown>): Prisma.InputJsonValue {
  if (!input) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_META_KEYS.has(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else if (value !== undefined) {
      clean[key] = value;
    }
  }
  return clean as Prisma.InputJsonValue;
}

/**
 * Persists structured, secret-free audit events for job and worker lifecycles
 * and serves organisation-scoped paginated event queries.
 */
export class EventService {
  /**
   * Persists an audit event safely (never throws to break primary execution paths).
   */
  async record(input: RecordEventInput): Promise<EventView | null> {
    try {
      const metadata = sanitizeMetadata(input.metadata);
      const created = await db.platformEvent.create({
        data: {
          type: input.type,
          organisationId: input.organisationId ?? null,
          queueId: input.queueId ?? null,
          jobId: input.jobId ?? null,
          workerId: input.workerId ?? null,
          message: input.message.slice(0, 500),
          metadata,
        },
      });

      // Invalidate short-TTL organisation metrics cache on operational events
      if (created.organisationId) {
        metricsService.invalidateOrganisation(created.organisationId);
      }

      // Best-effort publish to Redis Pub/Sub for real-time SSE fan-out (never throws)
      const realtimePayload = toRealtimePlatformEvent(created);
      if (realtimePayload) {
        await realtimeEventBus.publish(realtimePayload);
      }

      return created;
    } catch (err) {
      logger.warn('Failed to persist platform audit event', {
        type: input.type,
        organisationId: input.organisationId,
        jobId: input.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Lists persisted audit events strictly scoped to the caller's organisation.
   */
  async listForOrganisation(orgId: string, query: ListEventsQuery): Promise<PaginatedEventsView> {
    const where: Prisma.PlatformEventWhereInput = {
      organisationId: orgId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.queueId ? { queueId: query.queueId } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, events] = await Promise.all([
      db.platformEvent.count({ where }),
      db.platformEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      events,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
        hasNextPage: query.page < totalPages,
        hasPreviousPage: query.page > 1 && totalPages > 0,
      },
    };
  }

  /**
   * Replays persisted platform events strictly after `lastEventId` for a single organisation
   * in chronological order (`createdAt ASC, id ASC`), respecting the 30-day retention policy.
   * Foreign-organisation event UUIDs are indistinguishable from unknown cursors (`cursor_not_found`).
   */
  async replayAfterCursor(
    orgId: string,
    lastEventId: string,
    options?: { limit?: number; retentionDays?: number; now?: Date },
  ): Promise<ReplayEventsResult> {
    if (!uuidSchema.safeParse(lastEventId).success) {
      return { status: 'invalid_cursor', events: [], truncated: false };
    }

    const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_MAX_REPLAY_EVENTS, 500));
    const retentionDays = options?.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
    const now = options?.now ?? new Date();
    const retentionCutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    const cursor = await db.platformEvent.findFirst({
      where: {
        id: lastEventId,
        organisationId: orgId,
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    if (!cursor) {
      return { status: 'cursor_not_found', events: [], truncated: false };
    }

    if (cursor.createdAt < retentionCutoff) {
      return { status: 'cursor_expired', events: [], truncated: false };
    }

    const rows = await db.platformEvent.findMany({
      where: {
        organisationId: orgId,
        createdAt: { gte: retentionCutoff },
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    if (rows.length > limit) {
      return {
        status: 'truncated',
        events: rows.slice(0, limit),
        truncated: true,
      };
    }

    return {
      status: 'ok',
      events: rows,
      truncated: false,
    };
  }
}

export const eventService = new EventService();

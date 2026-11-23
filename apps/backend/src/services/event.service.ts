import { PlatformEventType, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';

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
}

export const eventService = new EventService();

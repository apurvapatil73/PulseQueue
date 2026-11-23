import { AlertSeverity, Prisma } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ListNotificationsQuery } from '../validators/alert.validator.js';

export interface NotificationView {
  id: string;
  organisationId: string;
  userId: string;
  alertId: string | null;
  eventKey: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface PaginatedNotificationsView {
  notifications: NotificationView[];
  unreadCount: number;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

/**
 * Organisation-scoped persistent in-app notification service.
 * Deduplicates notifications per `(userId, eventKey)` at the database level and never
 * throws on fan-out so durable alert transitions are never rolled back.
 */
export class NotificationService {
  /**
   * Creates deduplicated in-app notifications for all members of an organisation.
   */
  async notifyOrganisationMembers(input: {
    organisationId: string;
    alertId: string;
    eventKey: string;
    type: 'ALERT_FIRED' | 'ALERT_RESOLVED';
    severity: AlertSeverity;
    title: string;
    message: string;
  }): Promise<number> {
    try {
      const memberships = await db.membership.findMany({
        where: { organisationId: input.organisationId },
        select: { userId: true },
      });

      if (memberships.length === 0) {
        return 0;
      }

      const result = await db.notification.createMany({
        data: memberships.map((m) => ({
          organisationId: input.organisationId,
          userId: m.userId,
          alertId: input.alertId,
          eventKey: input.eventKey,
          type: input.type,
          severity: input.severity,
          title: input.title.slice(0, 200),
          message: input.message.slice(0, 500),
        })),
        skipDuplicates: true,
      });

      return result.count;
    } catch (err) {
      logger.warn('Failed to fan out in-app alert notifications (alert state preserved)', {
        organisationId: input.organisationId,
        alertId: input.alertId,
        eventKey: input.eventKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  async listForUser(
    orgId: string,
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<PaginatedNotificationsView> {
    const where: Prisma.NotificationWhereInput = {
      organisationId: orgId,
      userId,
      ...(query.unreadOnly ? { isRead: false } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, unreadCount, notifications] = await Promise.all([
      db.notification.count({ where }),
      db.notification.count({
        where: { organisationId: orgId, userId, isRead: false },
      }),
      db.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      notifications,
      unreadCount,
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

  async getUnreadCount(orgId: string, userId: string): Promise<number> {
    return db.notification.count({
      where: {
        organisationId: orgId,
        userId,
        isRead: false,
      },
    });
  }

  async markRead(orgId: string, userId: string, notificationId: string): Promise<NotificationView> {
    if (!uuidSchema.safeParse(notificationId).success) {
      throw new NotFoundError('Notification not found');
    }

    const existing = await db.notification.findFirst({
      where: {
        id: notificationId,
        organisationId: orgId,
        userId,
      },
    });

    if (!existing) {
      throw new NotFoundError('Notification not found');
    }

    if (existing.isRead) {
      return existing;
    }

    return db.notification.update({
      where: { id: existing.id },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  async markAllRead(orgId: string, userId: string): Promise<{ updatedCount: number }> {
    const res = await db.notification.updateMany({
      where: {
        organisationId: orgId,
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { updatedCount: res.count };
  }
}

export const notificationService = new NotificationService();

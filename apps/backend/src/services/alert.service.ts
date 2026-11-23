import {
  AlertComparisonOperator,
  AlertSeverity,
  AlertStatus,
  AlertType,
  PlatformEventType,
  Prisma,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors.js';
import { eventService } from './event.service.js';
import { notificationService } from './notification.service.js';
import type {
  CreateAlertRuleInput,
  ListAlertsQuery,
  UpdateAlertRuleInput,
} from '../validators/alert.validator.js';

export interface AlertRuleView {
  id: string;
  organisationId: string;
  queueId: string | null;
  queueName: string | null;
  name: string;
  description: string | null;
  type: AlertType;
  operator: AlertComparisonOperator;
  threshold: number;
  windowMinutes: number;
  cooldownSeconds: number;
  severity: AlertSeverity;
  isEnabled: boolean;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertView {
  id: string;
  organisationId: string;
  ruleId: string | null;
  queueId: string | null;
  queueName: string | null;
  dedupKey: string;
  ruleName: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  metricValue: number;
  threshold: number;
  occurrenceCount: number;
  firstTriggeredAt: Date;
  lastTriggeredAt: Date;
  lastEvaluatedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedById: string | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedAlertsView {
  alerts: AlertView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface AlertStatsView {
  total: number;
  firing: number;
  acknowledged: number;
  resolved: number;
  activeBySeverity: {
    info: number;
    warning: number;
    critical: number;
  };
  enabledRules: number;
  totalRules: number;
}

function toAlertRuleView(
  row: Prisma.AlertRuleGetPayload<{ include: { queue: { select: { name: true } } } }>,
): AlertRuleView {
  return {
    id: row.id,
    organisationId: row.organisationId,
    queueId: row.queueId,
    queueName: row.queue?.name ?? null,
    name: row.name,
    description: row.description,
    type: row.type,
    operator: row.operator,
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    cooldownSeconds: row.cooldownSeconds,
    severity: row.severity,
    isEnabled: row.isEnabled,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAlertView(
  row: Prisma.AlertGetPayload<{ include: { queue: { select: { name: true } } } }>,
): AlertView {
  return {
    id: row.id,
    organisationId: row.organisationId,
    ruleId: row.ruleId,
    queueId: row.queueId,
    queueName: row.queue?.name ?? null,
    dedupKey: row.dedupKey,
    ruleName: row.ruleName,
    type: row.type,
    severity: row.severity,
    status: row.status,
    message: row.message,
    metricValue: row.metricValue,
    threshold: row.threshold,
    occurrenceCount: row.occurrenceCount,
    firstTriggeredAt: row.firstTriggeredAt,
    lastTriggeredAt: row.lastTriggeredAt,
    lastEvaluatedAt: row.lastEvaluatedAt,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedById: row.acknowledgedById,
    resolvedAt: row.resolvedAt,
    resolvedById: row.resolvedById,
    resolutionReason: row.resolutionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const RULE_INCLUDE = { queue: { select: { name: true } } } as const;
const ALERT_INCLUDE = { queue: { select: { name: true } } } as const;

export class AlertService {
  private async assertQueueOwnership(orgId: string, queueId: string): Promise<void> {
    const queue = await db.queue.findFirst({
      where: { id: queueId, organisationId: orgId },
      select: { id: true },
    });
    if (!queue) {
      throw new NotFoundError('Queue not found');
    }
  }

  async createRule(
    orgId: string,
    actorUserId: string,
    input: CreateAlertRuleInput,
  ): Promise<AlertRuleView> {
    if (input.queueId) {
      await this.assertQueueOwnership(orgId, input.queueId);
    }

    try {
      const created = await db.alertRule.create({
        data: {
          organisationId: orgId,
          queueId: input.queueId ?? null,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          operator: input.operator,
          threshold: input.threshold,
          windowMinutes: input.windowMinutes,
          cooldownSeconds: input.cooldownSeconds,
          severity: input.severity,
          isEnabled: input.isEnabled,
          createdById: actorUserId,
          updatedById: actorUserId,
        },
        include: RULE_INCLUDE,
      });

      return toAlertRuleView(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(`An alert rule named "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async listRules(orgId: string): Promise<AlertRuleView[]> {
    const rows = await db.alertRule.findMany({
      where: { organisationId: orgId },
      include: RULE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map(toAlertRuleView);
  }

  async getRuleById(orgId: string, ruleId: string): Promise<AlertRuleView> {
    if (!uuidSchema.safeParse(ruleId).success) {
      throw new NotFoundError('Alert rule not found');
    }
    const row = await db.alertRule.findFirst({
      where: { id: ruleId, organisationId: orgId },
      include: RULE_INCLUDE,
    });
    if (!row) {
      throw new NotFoundError('Alert rule not found');
    }
    return toAlertRuleView(row);
  }

  async updateRule(
    orgId: string,
    ruleId: string,
    actorUserId: string,
    input: UpdateAlertRuleInput,
  ): Promise<AlertRuleView> {
    if (!uuidSchema.safeParse(ruleId).success) {
      throw new NotFoundError('Alert rule not found');
    }

    const existing = await db.alertRule.findFirst({
      where: { id: ruleId, organisationId: orgId },
    });
    if (!existing) {
      throw new NotFoundError('Alert rule not found');
    }

    if (
      (existing.type === AlertType.JOB_FAILURE_RATE ||
        existing.type === AlertType.JOB_RETRY_RATE) &&
      input.threshold !== undefined &&
      input.threshold > 100
    ) {
      throw new BadRequestError('Percentage threshold must be between 0 and 100');
    }

    if (
      (existing.type === AlertType.WORKER_STALE || existing.type === AlertType.SCHEDULE_MISFIRES) &&
      input.queueId
    ) {
      throw new BadRequestError(`${existing.type} rules cannot target a single queue`);
    }

    if (input.queueId) {
      await this.assertQueueOwnership(orgId, input.queueId);
    }

    try {
      const updated = await db.alertRule.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.operator !== undefined ? { operator: input.operator } : {}),
          ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
          ...(input.windowMinutes !== undefined ? { windowMinutes: input.windowMinutes } : {}),
          ...(input.cooldownSeconds !== undefined
            ? { cooldownSeconds: input.cooldownSeconds }
            : {}),
          ...(input.queueId !== undefined ? { queueId: input.queueId } : {}),
          ...(input.severity !== undefined ? { severity: input.severity } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
          updatedById: actorUserId,
        },
        include: RULE_INCLUDE,
      });

      return toAlertRuleView(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError(`An alert rule named "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async toggleRule(
    orgId: string,
    ruleId: string,
    actorUserId: string,
    isEnabled: boolean,
  ): Promise<AlertRuleView> {
    return this.updateRule(orgId, ruleId, actorUserId, { isEnabled });
  }

  /**
   * Deletes an alert rule while preserving all historical alerts (`ruleId` becomes null via SetNull).
   */
  async deleteRule(orgId: string, ruleId: string): Promise<void> {
    if (!uuidSchema.safeParse(ruleId).success) {
      throw new NotFoundError('Alert rule not found');
    }
    const existing = await db.alertRule.findFirst({
      where: { id: ruleId, organisationId: orgId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError('Alert rule not found');
    }

    await db.alertRule.delete({ where: { id: existing.id } });
  }

  // ─── Alerts ─────────────────────────────────────────────────────────────────

  async listAlerts(orgId: string, query: ListAlertsQuery): Promise<PaginatedAlertsView> {
    const where: Prisma.AlertWhereInput = {
      organisationId: orgId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.queueId ? { queueId: query.queueId } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, rows] = await Promise.all([
      db.alert.count({ where }),
      db.alert.findMany({
        where,
        include: ALERT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / query.limit);

    return {
      alerts: rows.map(toAlertView),
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

  async getAlertById(orgId: string, alertId: string): Promise<AlertView> {
    if (!uuidSchema.safeParse(alertId).success) {
      throw new NotFoundError('Alert not found');
    }
    const row = await db.alert.findFirst({
      where: { id: alertId, organisationId: orgId },
      include: ALERT_INCLUDE,
    });
    if (!row) {
      throw new NotFoundError('Alert not found');
    }
    return toAlertView(row);
  }

  async getAlertStats(orgId: string): Promise<AlertStatsView> {
    const [statusGroups, activeSeverityGroups, totalRules, enabledRules] = await Promise.all([
      db.alert.groupBy({
        by: ['status'],
        where: { organisationId: orgId },
        _count: { _all: true },
      }),
      db.alert.groupBy({
        by: ['severity'],
        where: {
          organisationId: orgId,
          status: { in: [AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED] },
        },
        _count: { _all: true },
      }),
      db.alertRule.count({ where: { organisationId: orgId } }),
      db.alertRule.count({ where: { organisationId: orgId, isEnabled: true } }),
    ]);

    let firing = 0;
    let acknowledged = 0;
    let resolved = 0;
    for (const row of statusGroups) {
      if (row.status === AlertStatus.FIRING) firing = row._count._all;
      if (row.status === AlertStatus.ACKNOWLEDGED) acknowledged = row._count._all;
      if (row.status === AlertStatus.RESOLVED) resolved = row._count._all;
    }

    const activeBySeverity = { info: 0, warning: 0, critical: 0 };
    for (const row of activeSeverityGroups) {
      if (row.severity === AlertSeverity.INFO) activeBySeverity.info = row._count._all;
      if (row.severity === AlertSeverity.WARNING) activeBySeverity.warning = row._count._all;
      if (row.severity === AlertSeverity.CRITICAL) activeBySeverity.critical = row._count._all;
    }

    return {
      total: firing + acknowledged + resolved,
      firing,
      acknowledged,
      resolved,
      activeBySeverity,
      enabledRules,
      totalRules,
    };
  }

  async acknowledgeAlert(orgId: string, alertId: string, actorUserId: string): Promise<AlertView> {
    if (!uuidSchema.safeParse(alertId).success) {
      throw new NotFoundError('Alert not found');
    }

    const existing = await db.alert.findFirst({
      where: { id: alertId, organisationId: orgId },
      include: ALERT_INCLUDE,
    });
    if (!existing) {
      throw new NotFoundError('Alert not found');
    }

    if (existing.status === AlertStatus.RESOLVED) {
      throw new ConflictError('Cannot acknowledge a resolved alert');
    }

    if (existing.status === AlertStatus.ACKNOWLEDGED) {
      return toAlertView(existing);
    }

    const updated = await db.alert.update({
      where: { id: existing.id },
      data: {
        status: AlertStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedById: actorUserId,
      },
      include: ALERT_INCLUDE,
    });

    await eventService.record({
      type: PlatformEventType.ALERT_ACKNOWLEDGED,
      organisationId: orgId,
      queueId: updated.queueId,
      message: `Alert "${updated.ruleName}" acknowledged`,
      metadata: {
        alertId: updated.id,
        ruleId: updated.ruleId,
        severity: updated.severity,
        acknowledgedById: actorUserId,
      },
    });

    return toAlertView(updated);
  }

  async resolveAlert(
    orgId: string,
    alertId: string,
    actorUserId: string | null,
    reason: string = 'Manually resolved',
  ): Promise<AlertView> {
    if (!uuidSchema.safeParse(alertId).success) {
      throw new NotFoundError('Alert not found');
    }

    const existing = await db.alert.findFirst({
      where: { id: alertId, organisationId: orgId },
      include: ALERT_INCLUDE,
    });
    if (!existing) {
      throw new NotFoundError('Alert not found');
    }

    if (existing.status === AlertStatus.RESOLVED) {
      return toAlertView(existing);
    }

    const now = new Date();
    const updated = await db.alert.update({
      where: { id: existing.id },
      data: {
        status: AlertStatus.RESOLVED,
        resolvedAt: now,
        resolvedById: actorUserId,
        resolutionReason: reason,
        lastEvaluatedAt: now,
      },
      include: ALERT_INCLUDE,
    });

    await eventService.record({
      type: PlatformEventType.ALERT_RESOLVED,
      organisationId: orgId,
      queueId: updated.queueId,
      message: `Alert "${updated.ruleName}" resolved (${reason})`,
      metadata: {
        alertId: updated.id,
        ruleId: updated.ruleId,
        severity: updated.severity,
        resolutionReason: reason,
      },
    });

    await notificationService.notifyOrganisationMembers({
      organisationId: orgId,
      alertId: updated.id,
      eventKey: `${updated.id}:RESOLVED`,
      type: 'ALERT_RESOLVED',
      severity: updated.severity,
      title: `Resolved: ${updated.ruleName}`,
      message: `Alert "${updated.ruleName}" has been resolved (${reason}).`,
    });

    return toAlertView(updated);
  }
}

export const alertService = new AlertService();

import {
  AlertComparisonOperator,
  AlertStatus,
  AlertType,
  PlatformEventType,
  Prisma,
  type AlertRule,
} from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { eventService } from './event.service.js';
import { metricsService, type OrganisationMetricsView } from './metrics.service.js';
import { notificationService } from './notification.service.js';

export interface AlertEvaluationSummary {
  organisationsEvaluated: number;
  rulesEvaluated: number;
  alertsFired: number;
  alertsUpdated: number;
  alertsResolved: number;
  skippedMissingMetric: number;
  skippedCooldown: number;
  skippedLocked: number;
}

export function compareMetric(
  value: number,
  operator: AlertComparisonOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case AlertComparisonOperator.GT:
      return value > threshold;
    case AlertComparisonOperator.GTE:
      return value >= threshold;
    case AlertComparisonOperator.LT:
      return value < threshold;
    case AlertComparisonOperator.LTE:
      return value <= threshold;
    default:
      return false;
  }
}

export function extractRuleMetricValue(
  rule: Pick<AlertRule, 'type' | 'queueId'>,
  metrics: OrganisationMetricsView,
): number | null {
  const queueItem = rule.queueId
    ? metrics.queues.find((q) => q.queueId === rule.queueId)
    : undefined;

  if (rule.queueId && !queueItem) {
    return null;
  }

  switch (rule.type) {
    case AlertType.QUEUE_BACKLOG:
      return queueItem ? queueItem.queueDepth : metrics.summary.queueDepth;

    case AlertType.QUEUE_WAIT_TIME:
      return queueItem ? queueItem.avgQueueWaitMs : metrics.latency.queueWait.avgMs;

    case AlertType.JOB_FAILURE_RATE: {
      const rate = queueItem ? queueItem.failureRate : metrics.summary.windowFailureRate;
      return rate !== null ? Math.round(rate * 100 * 100) / 100 : null;
    }

    case AlertType.JOB_RETRY_RATE: {
      if (queueItem) {
        return queueItem.retryRate !== null
          ? Math.round(queueItem.retryRate * 100 * 100) / 100
          : null;
      }
      if (metrics.summary.totalProcessed <= 0) return null;
      return (
        Math.round((metrics.summary.retriedJobs / metrics.summary.totalProcessed) * 100 * 100) / 100
      );
    }

    case AlertType.DLQ_COUNT:
      return queueItem ? queueItem.openDeadLetters : metrics.summary.deadLetterOpen;

    case AlertType.WORKER_STALE: {
      if (metrics.workerSummary.total === 0) {
        return null;
      }
      return metrics.workerSummary.stale + metrics.workerSummary.degraded;
    }

    case AlertType.JOB_LATENCY_P95:
      return queueItem ? queueItem.p95DurationMs : metrics.latency.executionDuration.p95Ms;

    case AlertType.SCHEDULE_MISFIRES:
      return metrics.reliability.scheduleMisfiresInWindow;

    default:
      return null;
  }
}

function formatAlertMessage(rule: AlertRule, value: number, queueName?: string): string {
  const scope = queueName ? ` on queue "${queueName}"` : '';
  const unit =
    rule.type === AlertType.JOB_FAILURE_RATE || rule.type === AlertType.JOB_RETRY_RATE
      ? '%'
      : rule.type === AlertType.QUEUE_WAIT_TIME || rule.type === AlertType.JOB_LATENCY_P95
        ? 'ms'
        : '';
  return `${rule.name}${scope}: observed ${value}${unit} (${rule.operator} ${rule.threshold}${unit} over ${rule.windowMinutes}m window)`;
}

/**
 * Deterministic 32-bit advisory lock key derived from an organisationId string.
 */
function hashOrgLockKey(orgId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < orgId.length; i += 1) {
    hash ^= orgId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

/**
 * Periodic multi-tenant alert evaluation engine.
 *
 * - Runs on a bounded interval inside WorkerRuntime without blocking job processing.
 * - Uses PostgreSQL transaction-scoped advisory locks + partial unique active alert index
 *   to guarantee safe concurrent evaluation across multiple worker replicas.
 * - Evaluates each organisation and rule independently using live MetricsService data.
 * - Never generates false alerts on missing/insufficient metrics.
 */
export class AlertEvaluatorService {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  async evaluateAll(options?: {
    organisationId?: string;
    now?: Date;
  }): Promise<AlertEvaluationSummary> {
    const summary: AlertEvaluationSummary = {
      organisationsEvaluated: 0,
      rulesEvaluated: 0,
      alertsFired: 0,
      alertsUpdated: 0,
      alertsResolved: 0,
      skippedMissingMetric: 0,
      skippedCooldown: 0,
      skippedLocked: 0,
    };

    if (this.inFlight) {
      return summary;
    }

    this.inFlight = true;
    const now = options?.now ?? new Date();

    try {
      const rules = await db.alertRule.findMany({
        where: {
          isEnabled: true,
          ...(options?.organisationId ? { organisationId: options.organisationId } : {}),
        },
        orderBy: [{ organisationId: 'asc' }, { windowMinutes: 'asc' }],
      });

      if (rules.length === 0) {
        return summary;
      }

      const rulesByOrg = new Map<string, AlertRule[]>();
      for (const rule of rules) {
        const list = rulesByOrg.get(rule.organisationId) ?? [];
        list.push(rule);
        rulesByOrg.set(rule.organisationId, list);
      }

      for (const [orgId, orgRules] of rulesByOrg.entries()) {
        try {
          await this.evaluateOrganisation(orgId, orgRules, now, summary);
        } catch (err) {
          logger.warn('Alert evaluation failed for organisation', {
            organisationId: orgId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return summary;
    } finally {
      this.inFlight = false;
    }
  }

  private async evaluateOrganisation(
    orgId: string,
    rules: AlertRule[],
    now: Date,
    summary: AlertEvaluationSummary,
  ): Promise<void> {
    // Pre-fetch metrics once per distinct windowMinutes for this organisation
    const metricsByWindow = new Map<number, OrganisationMetricsView>();
    const uniqueWindows = Array.from(new Set(rules.map((r) => r.windowMinutes)));
    for (const wm of uniqueWindows) {
      const m = await metricsService.getOrganisationMetrics(orgId, wm, { bypassCache: true });
      metricsByWindow.set(wm, m);
    }

    const lockKey = hashOrgLockKey(orgId);

    // Side-effect actions collected inside the advisory-locked transaction and executed right after commit
    const postCommitEffects: Array<() => Promise<void>> = [];

    const locked = await db.$transaction(
      async (tx) => {
        const lockRows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_xact_lock(76001::int4, ${lockKey}::int4) AS acquired
        `;
        if (!lockRows[0]?.acquired) {
          return false;
        }

        summary.organisationsEvaluated += 1;

        for (const rule of rules) {
          summary.rulesEvaluated += 1;
          const metrics = metricsByWindow.get(rule.windowMinutes)!;
          const metricValue = extractRuleMetricValue(rule, metrics);

          if (metricValue === null || !Number.isFinite(metricValue)) {
            summary.skippedMissingMetric += 1;
            continue;
          }

          const dedupKey = `${rule.id}:${rule.queueId ?? 'org'}`;
          const breached = compareMetric(metricValue, rule.operator, rule.threshold);
          const queueName = rule.queueId
            ? metrics.queues.find((q) => q.queueId === rule.queueId)?.name
            : undefined;

          const activeAlert = await tx.alert.findFirst({
            where: {
              organisationId: orgId,
              dedupKey,
              status: { in: [AlertStatus.FIRING, AlertStatus.ACKNOWLEDGED] },
            },
          });

          if (breached) {
            if (activeAlert) {
              // Condition still active -> deduplicate by updating existing alert (respecting cooldown for occurrenceCount)
              const elapsedSec = (now.getTime() - activeAlert.lastTriggeredAt.getTime()) / 1000;
              const shouldBumpOccurrence = elapsedSec >= rule.cooldownSeconds;

              await tx.alert.update({
                where: { id: activeAlert.id },
                data: {
                  metricValue,
                  threshold: rule.threshold,
                  severity: rule.severity,
                  message: formatAlertMessage(rule, metricValue, queueName),
                  lastEvaluatedAt: now,
                  ...(shouldBumpOccurrence
                    ? {
                        lastTriggeredAt: now,
                        occurrenceCount: { increment: 1 },
                      }
                    : {}),
                },
              });
              summary.alertsUpdated += 1;
            } else {
              // Check cooldown against most recent RESOLVED alert for this dedupKey
              if (rule.cooldownSeconds > 0) {
                const lastResolved = await tx.alert.findFirst({
                  where: {
                    organisationId: orgId,
                    dedupKey,
                    status: AlertStatus.RESOLVED,
                  },
                  orderBy: { resolvedAt: 'desc' },
                  select: { resolvedAt: true },
                });
                if (
                  lastResolved?.resolvedAt &&
                  now.getTime() - lastResolved.resolvedAt.getTime() < rule.cooldownSeconds * 1000
                ) {
                  summary.skippedCooldown += 1;
                  continue;
                }
              }

              const message = formatAlertMessage(rule, metricValue, queueName);
              try {
                const created = await tx.alert.create({
                  data: {
                    organisationId: orgId,
                    ruleId: rule.id,
                    queueId: rule.queueId,
                    dedupKey,
                    ruleName: rule.name,
                    type: rule.type,
                    severity: rule.severity,
                    status: AlertStatus.FIRING,
                    message,
                    metricValue,
                    threshold: rule.threshold,
                    occurrenceCount: 1,
                    firstTriggeredAt: now,
                    lastTriggeredAt: now,
                    lastEvaluatedAt: now,
                  },
                });
                summary.alertsFired += 1;

                postCommitEffects.push(async () => {
                  await eventService.record({
                    type: PlatformEventType.ALERT_FIRED,
                    organisationId: orgId,
                    queueId: created.queueId,
                    message: created.message,
                    metadata: {
                      alertId: created.id,
                      ruleId: created.ruleId,
                      alertType: created.type,
                      severity: created.severity,
                      metricValue: created.metricValue,
                      threshold: created.threshold,
                    },
                  });
                  await notificationService.notifyOrganisationMembers({
                    organisationId: orgId,
                    alertId: created.id,
                    eventKey: `${created.id}:FIRED`,
                    type: 'ALERT_FIRED',
                    severity: created.severity,
                    title: `${created.severity}: ${created.ruleName}`,
                    message: created.message,
                  });
                });
              } catch (err) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                  // Concurrent duplicate blocked by partial unique index
                  summary.alertsUpdated += 1;
                } else {
                  throw err;
                }
              }
            }
          } else if (activeAlert) {
            // Condition recovered -> resolve active alert
            const resolved = await tx.alert.update({
              where: { id: activeAlert.id },
              data: {
                status: AlertStatus.RESOLVED,
                metricValue,
                lastEvaluatedAt: now,
                resolvedAt: now,
                resolutionReason: 'Condition returned to normal',
              },
            });
            summary.alertsResolved += 1;

            postCommitEffects.push(async () => {
              await eventService.record({
                type: PlatformEventType.ALERT_RESOLVED,
                organisationId: orgId,
                queueId: resolved.queueId,
                message: `Alert "${resolved.ruleName}" recovered (observed ${metricValue})`,
                metadata: {
                  alertId: resolved.id,
                  ruleId: resolved.ruleId,
                  alertType: resolved.type,
                  severity: resolved.severity,
                  metricValue,
                  threshold: resolved.threshold,
                },
              });
              await notificationService.notifyOrganisationMembers({
                organisationId: orgId,
                alertId: resolved.id,
                eventKey: `${resolved.id}:RESOLVED`,
                type: 'ALERT_RESOLVED',
                severity: resolved.severity,
                title: `Resolved: ${resolved.ruleName}`,
                message: `Alert "${resolved.ruleName}" recovered (observed ${metricValue}).`,
              });
            });
          }
        }

        return true;
      },
      { maxWait: 5_000, timeout: 15_000 },
    );

    if (!locked) {
      summary.skippedLocked += 1;
      return;
    }

    // Execute post-commit audit events, SSE fan-out, and in-app notifications safely
    for (const effect of postCommitEffects) {
      try {
        await effect();
      } catch (err) {
        logger.warn('Post-commit alert notification/event effect failed', {
          organisationId: orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  start(intervalMs: number = 30_000): void {
    if (this.timer) return;
    const safeInterval = Math.max(5_000, intervalMs);
    this.timer = setInterval(() => {
      void this.evaluateAll().catch((err) => {
        logger.warn('Scheduled alert evaluation cycle failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, safeInterval);
    this.timer.unref();
    logger.info('Alert evaluation engine started', { intervalMs: safeInterval });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Alert evaluation engine stopped');
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const alertEvaluatorService = new AlertEvaluatorService();

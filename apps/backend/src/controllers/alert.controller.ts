import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { alertService } from '../services/alert.service.js';
import { notificationService } from '../services/notification.service.js';
import {
  createAlertRuleSchema,
  updateAlertRuleSchema,
  toggleAlertRuleSchema,
  listAlertsQuerySchema,
  resolveAlertBodySchema,
  listNotificationsQuerySchema,
} from '../validators/alert.validator.js';
import { sendSuccess } from '../utils/response.js';
import { BadRequestError, UnauthorizedError } from '../utils/errors.js';

function parseInput<T>(schema: { parse: (d: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestError('Validation failed', err.flatten().fieldErrors);
    }
    throw err;
  }
}

function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

// ─── Alert Rules ──────────────────────────────────────────────────────────────

export async function listAlertRules(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const rules = await alertService.listRules(req.membership.organisationId);
    sendSuccess(res, { rules });
  } catch (err) {
    next(err);
  }
}

export async function getAlertRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const rule = await alertService.getRuleById(
      req.membership.organisationId,
      param(req, 'ruleId'),
    );
    sendSuccess(res, { rule });
  } catch (err) {
    next(err);
  }
}

export async function createAlertRule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const input = parseInput(createAlertRuleSchema, req.body);
    const rule = await alertService.createRule(req.membership.organisationId, req.user.id, input);
    sendSuccess(res, { rule }, 201);
  } catch (err) {
    next(err);
  }
}

export async function updateAlertRule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const input = parseInput(updateAlertRuleSchema, req.body);
    const rule = await alertService.updateRule(
      req.membership.organisationId,
      param(req, 'ruleId'),
      req.user.id,
      input,
    );
    sendSuccess(res, { rule });
  } catch (err) {
    next(err);
  }
}

export async function toggleAlertRule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const { isEnabled } = parseInput(toggleAlertRuleSchema, req.body);
    const rule = await alertService.toggleRule(
      req.membership.organisationId,
      param(req, 'ruleId'),
      req.user.id,
      isEnabled,
    );
    sendSuccess(res, { rule });
  } catch (err) {
    next(err);
  }
}

export async function deleteAlertRule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    await alertService.deleteRule(req.membership.organisationId, param(req, 'ruleId'));
    sendSuccess(res, { deleted: true });
  } catch (err) {
    next(err);
  }
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export async function listAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listAlertsQuerySchema, req.query);
    const result = await alertService.listAlerts(req.membership.organisationId, query);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getAlertStats(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const stats = await alertService.getAlertStats(req.membership.organisationId);
    sendSuccess(res, { stats });
  } catch (err) {
    next(err);
  }
}

export async function getAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const alert = await alertService.getAlertById(
      req.membership.organisationId,
      param(req, 'alertId'),
    );
    sendSuccess(res, { alert });
  } catch (err) {
    next(err);
  }
}

export async function acknowledgeAlert(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const alert = await alertService.acknowledgeAlert(
      req.membership.organisationId,
      param(req, 'alertId'),
      req.user.id,
    );
    sendSuccess(res, { alert });
  } catch (err) {
    next(err);
  }
}

export async function resolveAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const { reason } = parseInput(resolveAlertBodySchema, req.body ?? {});
    const alert = await alertService.resolveAlert(
      req.membership.organisationId,
      param(req, 'alertId'),
      req.user.id,
      reason,
    );
    sendSuccess(res, { alert });
  } catch (err) {
    next(err);
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

export async function listNotifications(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const query = parseInput(listNotificationsQuerySchema, req.query);
    const result = await notificationService.listForUser(
      req.membership.organisationId,
      req.user.id,
      query,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getUnreadNotificationCount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const unreadCount = await notificationService.getUnreadCount(
      req.membership.organisationId,
      req.user.id,
    );
    sendSuccess(res, { unreadCount });
  } catch (err) {
    next(err);
  }
}

export async function markNotificationRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const notification = await notificationService.markRead(
      req.membership.organisationId,
      req.user.id,
      param(req, 'notificationId'),
    );
    sendSuccess(res, { notification });
  } catch (err) {
    next(err);
  }
}

export async function markAllNotificationsRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const result = await notificationService.markAllRead(
      req.membership.organisationId,
      req.user.id,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

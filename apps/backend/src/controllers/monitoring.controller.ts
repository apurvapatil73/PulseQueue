import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { deadLetterService } from '../services/dlq.service.js';
import { metricsService } from '../services/metrics.service.js';
import { workerHealthService } from '../services/workerHealth.service.js';
import { eventService } from '../services/event.service.js';
import { stalledJobRecoveryService } from '../services/stalledJobRecovery.service.js';
import {
  listDlqQuerySchema,
  replayDlqBodySchema,
  metricsQuerySchema,
  listEventsQuerySchema,
  recoverStalledBodySchema,
} from '../validators/monitoring.validator.js';
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

// ─── Dead-Letter Queue (DLQ) ──────────────────────────────────────────────────

export async function listDlqJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listDlqQuerySchema, req.query);
    const result = await deadLetterService.listForOrganisation(
      req.membership.organisationId,
      query,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getDlqJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const deadLetterJob = await deadLetterService.getById(
      req.membership.organisationId,
      param(req, 'dlqId'),
    );
    sendSuccess(res, { deadLetterJob });
  } catch (err) {
    next(err);
  }
}

export async function replayDlqJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const overrides = parseInput(replayDlqBodySchema, req.body ?? {});
    const result = await deadLetterService.replay(
      req.membership.organisationId,
      param(req, 'dlqId'),
      req.user.id,
      overrides,
    );
    sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
}

// ─── Monitoring, Metrics, Workers & Events ────────────────────────────────────

export async function getOrganisationMetrics(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const { windowMinutes } = parseInput(metricsQuerySchema, req.query);
    const metrics = await metricsService.getOrganisationMetrics(
      req.membership.organisationId,
      windowMinutes,
    );
    sendSuccess(res, { metrics });
  } catch (err) {
    next(err);
  }
}

export async function listOrganisationWorkers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const workers = await workerHealthService.listWorkersForOrganisation(
      req.membership.organisationId,
    );
    sendSuccess(res, { workers });
  } catch (err) {
    next(err);
  }
}

export async function listOrganisationEvents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listEventsQuerySchema, req.query);
    const result = await eventService.listForOrganisation(req.membership.organisationId, query);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function triggerStalledRecovery(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const options = parseInput(recoverStalledBodySchema, req.body ?? {});
    const summary = await stalledJobRecoveryService.recoverStalledJobs({
      organisationId: req.membership.organisationId,
      ...options,
    });
    sendSuccess(res, { summary });
  } catch (err) {
    next(err);
  }
}

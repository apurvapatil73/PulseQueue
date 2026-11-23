import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { scheduleService } from '../services/schedule.service.js';
import {
  createScheduleSchema,
  listScheduleExecutionsQuerySchema,
  listSchedulesQuerySchema,
  updateScheduleSchema,
} from '../validators/schedule.validator.js';
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

export async function createSchedule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const input = parseInput(createScheduleSchema, req.body);
    const result = await scheduleService.create(req.membership.organisationId, req.user.id, input);
    sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
}

export async function listSchedules(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listSchedulesQuerySchema, req.query);
    const result = await scheduleService.list(req.membership.organisationId, query);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getSchedule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const schedule = await scheduleService.getById(
      req.membership.organisationId,
      param(req, 'scheduleId'),
    );
    sendSuccess(res, { schedule });
  } catch (err) {
    next(err);
  }
}

export async function updateSchedule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const input = parseInput(updateScheduleSchema, req.body);
    const schedule = await scheduleService.update(
      req.membership.organisationId,
      param(req, 'scheduleId'),
      input,
      req.user.id,
    );
    sendSuccess(res, { schedule });
  } catch (err) {
    next(err);
  }
}

export async function pauseSchedule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const schedule = await scheduleService.pause(
      req.membership.organisationId,
      param(req, 'scheduleId'),
      req.user.id,
    );
    sendSuccess(res, { schedule });
  } catch (err) {
    next(err);
  }
}

export async function resumeSchedule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const schedule = await scheduleService.resume(
      req.membership.organisationId,
      param(req, 'scheduleId'),
      req.user.id,
    );
    sendSuccess(res, { schedule });
  } catch (err) {
    next(err);
  }
}

export async function cancelSchedule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const schedule = await scheduleService.cancel(
      req.membership.organisationId,
      param(req, 'scheduleId'),
      req.user.id,
    );
    sendSuccess(res, { schedule });
  } catch (err) {
    next(err);
  }
}

export async function deleteSchedule(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    await scheduleService.delete(
      req.membership.organisationId,
      param(req, 'scheduleId'),
      req.user.id,
    );
    sendSuccess(res, { message: 'Schedule deleted successfully' });
  } catch (err) {
    next(err);
  }
}

export async function listScheduleExecutions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listScheduleExecutionsQuerySchema, req.query);
    const result = await scheduleService.listExecutions(
      req.membership.organisationId,
      param(req, 'scheduleId'),
      query,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getScheduleNextRun(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const preview = await scheduleService.getNextRunPreview(
      req.membership.organisationId,
      param(req, 'scheduleId'),
    );
    sendSuccess(res, { nextRun: preview });
  } catch (err) {
    next(err);
  }
}

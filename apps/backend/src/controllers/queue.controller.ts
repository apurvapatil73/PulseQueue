import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { queueService } from '../services/queue.service.js';
import {
  createQueueSchema,
  updateQueueSchema,
  listQueuesQuerySchema,
} from '../validators/queue.validator.js';
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

export async function createQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if ((!req.user && !req.apiKey) || !req.membership) throw new UnauthorizedError();
    const input = parseInput(createQueueSchema, req.body);
    const queue = await queueService.create(
      req.membership.organisationId,
      req.user?.id ?? null,
      input,
    );
    sendSuccess(res, { queue }, 201);
  } catch (err) {
    next(err);
  }
}

export async function listQueues(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listQueuesQuerySchema, req.query);
    const queues = await queueService.list(req.membership.organisationId, query);
    sendSuccess(res, { queues });
  } catch (err) {
    next(err);
  }
}

export async function getQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const queue = await queueService.getById(req.membership.organisationId, param(req, 'queueId'));
    sendSuccess(res, { queue });
  } catch (err) {
    next(err);
  }
}

export async function updateQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if ((!req.user && !req.apiKey) || !req.membership) throw new UnauthorizedError();
    const input = parseInput(updateQueueSchema, req.body);
    const queue = await queueService.update(
      req.membership.organisationId,
      param(req, 'queueId'),
      input,
      req.user?.id ?? `apikey:${req.apiKey!.id}`,
    );
    sendSuccess(res, { queue });
  } catch (err) {
    next(err);
  }
}

export async function deleteQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    await queueService.delete(req.membership.organisationId, param(req, 'queueId'), req.user.id);
    sendSuccess(res, { message: 'Queue deleted successfully' });
  } catch (err) {
    next(err);
  }
}

export async function pauseQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const queue = await queueService.pause(
      req.membership.organisationId,
      param(req, 'queueId'),
      req.user.id,
    );
    sendSuccess(res, { queue });
  } catch (err) {
    next(err);
  }
}

export async function resumeQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const queue = await queueService.resume(
      req.membership.organisationId,
      param(req, 'queueId'),
      req.user.id,
    );
    sendSuccess(res, { queue });
  } catch (err) {
    next(err);
  }
}

export async function getQueueStats(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const stats = await queueService.getStats(req.membership.organisationId, param(req, 'queueId'));
    sendSuccess(res, { stats });
  } catch (err) {
    next(err);
  }
}

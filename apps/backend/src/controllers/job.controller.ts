import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { jobService } from '../services/job.service.js';
import { createJobSchema, listJobsQuerySchema } from '../validators/job.validator.js';
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

function optionalParam(req: Request, key: string): string | undefined {
  const val = req.params[key];
  if (val === undefined) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

export async function createJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if ((!req.user && !req.apiKey) || !req.membership) throw new UnauthorizedError();
    const headerIdempotencyKey = req.header('idempotency-key')?.trim();
    const rawBody =
      req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const mergedBody =
      headerIdempotencyKey && rawBody.idempotencyKey === undefined
        ? { ...rawBody, idempotencyKey: headerIdempotencyKey }
        : rawBody;
    const input = parseInput(createJobSchema, mergedBody);
    const { job, dispatch, deduplicated } = await jobService.create(
      req.membership.organisationId,
      param(req, 'queueId'),
      req.user?.id ?? null,
      input,
    );
    sendSuccess(
      res,
      deduplicated ? { job, dispatch, deduplicated: true } : { job, dispatch },
      deduplicated ? 200 : 201,
    );
  } catch (err) {
    next(err);
  }
}

export async function listQueueJobs(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const query = parseInput(listJobsQuerySchema, req.query);
    const result = await jobService.listByQueue(
      req.membership.organisationId,
      param(req, 'queueId'),
      query,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const job = await jobService.getById(
      req.membership.organisationId,
      param(req, 'jobId'),
      optionalParam(req, 'queueId'),
    );
    sendSuccess(res, { job });
  } catch (err) {
    next(err);
  }
}

export async function cancelJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if ((!req.user && !req.apiKey) || !req.membership) throw new UnauthorizedError();
    const result = await jobService.cancel(
      req.membership.organisationId,
      param(req, 'jobId'),
      req.user?.id ?? `apikey:${req.apiKey!.id}`,
      optionalParam(req, 'queueId'),
    );
    sendSuccess(res, {
      ...result,
      message: 'Job cancelled successfully',
    });
  } catch (err) {
    next(err);
  }
}

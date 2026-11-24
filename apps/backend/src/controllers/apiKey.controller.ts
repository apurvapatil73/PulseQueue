import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { apiKeyService } from '../services/apiKey.service.js';
import { createApiKeySchema, rotateApiKeySchema } from '../validators/apiKey.validator.js';
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

export async function createApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const input = parseInput(createApiKeySchema, req.body);
    const result = await apiKeyService.create(req.membership.organisationId, req.user.id, input);
    sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
}

export async function listApiKeys(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const apiKeys = await apiKeyService.list(req.membership.organisationId);
    sendSuccess(res, { apiKeys });
  } catch (err) {
    next(err);
  }
}

export async function revokeApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const apiKey = await apiKeyService.revoke(
      req.membership.organisationId,
      param(req, 'apiKeyId'),
      req.user.id,
    );
    sendSuccess(res, { apiKey, message: 'API key revoked successfully' });
  } catch (err) {
    next(err);
  }
}

export async function rotateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user || !req.membership) throw new UnauthorizedError();
    const input = parseInput(rotateApiKeySchema, req.body ?? {});
    const result = await apiKeyService.rotate(
      req.membership.organisationId,
      param(req, 'apiKeyId'),
      req.user.id,
      input,
    );
    sendSuccess(res, result, 200);
  } catch (err) {
    next(err);
  }
}

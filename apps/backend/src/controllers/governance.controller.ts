import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { governanceService } from '../services/governance.service.js';
import { updateOrgQuotasSchema } from '../validators/governance.validator.js';
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

export async function getOrganisationGovernance(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const governance = await governanceService.getOrganisationGovernance(
      req.membership.organisationId,
    );
    sendSuccess(res, { governance });
  } catch (err) {
    next(err);
  }
}

export async function updateOrganisationQuotas(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const input = parseInput(updateOrgQuotasSchema, req.body);
    const governance = await governanceService.updateOrganisationQuotas(
      req.membership.organisationId,
      input,
    );
    sendSuccess(res, { governance });
  } catch (err) {
    next(err);
  }
}

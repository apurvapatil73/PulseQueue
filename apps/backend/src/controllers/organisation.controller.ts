import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { organisationService } from '../services/organisation.service.js';
import {
  createOrgSchema,
  updateOrgSchema,
  updateMemberRoleSchema,
  transferOwnershipSchema,
  createInvitationSchema,
  acceptInvitationSchema,
} from '../validators/organisation.validator.js';
import { sendSuccess } from '../utils/response.js';
import { BadRequestError, UnauthorizedError } from '../utils/errors.js';

function parseBody<T>(schema: { parse: (d: unknown) => T }, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestError('Validation failed', err.flatten().fieldErrors);
    }
    throw err;
  }
}

/** Extract a single string param — guards against Express's string | string[] union. */
function param(req: Request, key: string): string {
  const val = req.params[key];
  return Array.isArray(val) ? val[0] : val;
}

// ─── Organisations ───────────────────────────────────────────────────────────

export async function createOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError();
    const { name } = parseBody(createOrgSchema, req.body);
    const organisation = await organisationService.create(req.user.id, name);
    sendSuccess(res, { organisation }, 201);
  } catch (err) {
    next(err);
  }
}

export async function listOrgs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError();
    const organisations = await organisationService.listForUser(req.user.id);
    sendSuccess(res, { organisations });
  } catch (err) {
    next(err);
  }
}

export async function getOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const organisation = await organisationService.getById(
      param(req, 'organisationId'),
      req.membership?.role,
    );
    sendSuccess(res, { organisation });
  } catch (err) {
    next(err);
  }
}

export async function updateOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name } = parseBody(updateOrgSchema, req.body);
    if (!name) throw new BadRequestError('At least one updatable field must be provided');
    const organisation = await organisationService.update(param(req, 'organisationId'), name);
    sendSuccess(res, { organisation });
  } catch (err) {
    next(err);
  }
}

export async function deleteOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await organisationService.delete(param(req, 'organisationId'));
    sendSuccess(res, { message: 'Organisation deleted successfully' });
  } catch (err) {
    next(err);
  }
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function listMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const members = await organisationService.listMembers(param(req, 'organisationId'));
    sendSuccess(res, { members });
  } catch (err) {
    next(err);
  }
}

export async function updateMemberRole(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const { role } = parseBody(updateMemberRoleSchema, req.body);
    const member = await organisationService.updateMemberRole(
      param(req, 'organisationId'),
      param(req, 'userId'),
      role,
      req.membership,
    );
    sendSuccess(res, { member });
  } catch (err) {
    next(err);
  }
}

export async function transferOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError();
    const { targetUserId } = parseBody(transferOwnershipSchema, req.body);
    const result = await organisationService.transferOwnership(
      param(req, 'organisationId'),
      targetUserId,
      req.user.id,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function removeMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    await organisationService.removeMember(
      param(req, 'organisationId'),
      param(req, 'userId'),
      req.membership,
    );
    sendSuccess(res, { message: 'Member removed successfully' });
  } catch (err) {
    next(err);
  }
}

// ─── Invitations ─────────────────────────────────────────────────────────────

export async function createInvitation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.membership) throw new UnauthorizedError();
    const { email, role } = parseBody(createInvitationSchema, req.body);
    const result = await organisationService.createInvitation(
      param(req, 'organisationId'),
      req.membership,
      email,
      role,
    );
    sendSuccess(res, result, 201);
  } catch (err) {
    next(err);
  }
}

export async function listInvitations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const invitations = await organisationService.listInvitations(param(req, 'organisationId'));
    sendSuccess(res, { invitations });
  } catch (err) {
    next(err);
  }
}

export async function revokeInvitation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await organisationService.revokeInvitation(
      param(req, 'organisationId'),
      param(req, 'invitationId'),
    );
    sendSuccess(res, { message: 'Invitation revoked successfully' });
  } catch (err) {
    next(err);
  }
}

// ─── Accept Invitation (standalone — no org context required) ─────────────────

export async function acceptInvitation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError();
    const { token } = parseBody(acceptInvitationSchema, req.body);
    const membership = await organisationService.acceptInvitation(token, req.user.id);
    sendSuccess(res, { membership });
  } catch (err) {
    next(err);
  }
}

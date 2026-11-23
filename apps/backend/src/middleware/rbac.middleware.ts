import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors.js';

/**
 * Numeric weight for each role — higher = more privilege.
 */
const ROLE_WEIGHT: Record<Role, number> = {
  [Role.OWNER]: 3,
  [Role.ADMIN]: 2,
  [Role.MEMBER]: 1,
};

/**
 * Returns true if `actual` has at least the privilege level of `minimum`.
 */
export function hasMinimumRole(actual: Role, minimum: Role): boolean {
  return ROLE_WEIGHT[actual] >= ROLE_WEIGHT[minimum];
}

/**
 * Reusable RBAC middleware factory.
 *
 * Looks up the authenticated user's membership in the organisation identified by
 * `req.params.organisationId` directly from PostgreSQL, attaches it to
 * `req.membership`, and enforces `minRole`.
 *
 * Security guarantees:
 * - Never trusts role values supplied by the client.
 * - Validates UUID syntax before querying PostgreSQL to avoid DB error leaks.
 * - Returns 401 if unauthenticated.
 * - Returns 404 if user is not a member (avoids confirming org existence to outsiders).
 * - Returns 403 if user is a member but lacks the required role.
 */
export function requireOrgRole(minRole: Role) {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required');
      }

      const rawParam = req.params['organisationId'];
      const organisationId = Array.isArray(rawParam) ? rawParam[0] : rawParam;

      if (!organisationId || !uuidSchema.safeParse(organisationId).success) {
        throw new NotFoundError('Organisation not found');
      }

      const membership = await db.membership.findUnique({
        where: {
          userId_organisationId: {
            userId: req.user.id,
            organisationId,
          },
        },
        select: {
          id: true,
          userId: true,
          organisationId: true,
          role: true,
        },
      });

      // Use 404 to avoid confirming existence of organisations to non-members
      if (!membership) {
        throw new NotFoundError('Organisation not found');
      }

      if (!hasMinimumRole(membership.role, minRole)) {
        throw new ForbiddenError('You do not have permission to perform this action');
      }

      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

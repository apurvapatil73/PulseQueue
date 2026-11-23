import { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  /** JWT expiration timestamp in epoch seconds, when present. */
  tokenExp?: number;
}

export interface RequestMembership {
  id: string;
  userId: string;
  organisationId: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      membership?: RequestMembership;
    }
  }
}

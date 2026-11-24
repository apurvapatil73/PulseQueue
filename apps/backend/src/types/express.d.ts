import { Role } from '@prisma/client';
import type { AuthenticatedApiKey } from '../services/apiKey.service.js';

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
      apiKey?: AuthenticatedApiKey;
      membership?: RequestMembership;
    }
  }
}

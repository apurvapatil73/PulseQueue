import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/security.js';
import { UnauthorizedError } from '../utils/errors.js';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    throw new UnauthorizedError('Authorization header with Bearer token is required');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw new UnauthorizedError('Malformed Authorization header. Format: Bearer <token>');
  }

  const token = parts[1];

  try {
    const payload = verifyAccessToken(token);

    // Securely attach authenticated user context from token payload ONLY
    req.user = {
      id: payload.sub,
      email: payload.email,
      ...(typeof payload.exp === 'number' ? { tokenExp: payload.exp } : {}),
    };

    next();
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TokenExpiredError'
        ? 'Access token has expired'
        : 'Invalid access token';
    throw new UnauthorizedError(message);
  }
}

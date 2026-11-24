import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/security.js';
import { UnauthorizedError } from '../utils/errors.js';
import { apiKeyService } from '../services/apiKey.service.js';

function extractApiKeyHeader(req: Request): string | undefined {
  const xApiKey = req.header('x-api-key')?.trim();
  if (xApiKey) return xApiKey;

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'ApiKey' && parts[1].trim().length > 0) {
      return parts[1].trim();
    }
  }
  return undefined;
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // 1. Check tenant-scoped API key header (X-API-Key or Authorization: ApiKey <key>)
    const rawApiKey = extractApiKeyHeader(req);
    if (rawApiKey !== undefined) {
      const verifiedKey = await apiKeyService.authenticateKey(rawApiKey);
      if (!verifiedKey) {
        throw new UnauthorizedError('Invalid, expired, or revoked API key');
      }
      req.apiKey = verifiedKey;
      next();
      return;
    }

    // 2. Standard JWT Bearer token authentication
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
  } catch (err) {
    next(err);
  }
}

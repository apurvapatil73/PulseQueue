import { Request, Response, NextFunction, CookieOptions } from 'express';
import { authService } from '../services/auth.service.js';
import { registerSchema, loginSchema, refreshTokenSchema } from '../validators/auth.validator.js';
import { sendSuccess } from '../utils/response.js';
import { BadRequestError, UnauthorizedError } from '../utils/errors.js';
import { env } from '../config/env.js';
import { REFRESH_TOKEN_TTL_MS } from '../utils/security.js';

const REFRESH_COOKIE_NAME = 'pq_refresh_token';

function getRefreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/v1/auth',
    maxAge: REFRESH_TOKEN_TTL_MS,
  };
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    if (key === name) {
      try {
        return decodeURIComponent(pair.slice(idx + 1).trim());
      } catch {
        return pair.slice(idx + 1).trim();
      }
    }
  }
  return undefined;
}

function extractRefreshToken(req: Request): string | undefined {
  const bodyToken =
    typeof req.body?.refreshToken === 'string' && req.body.refreshToken.trim().length > 0
      ? req.body.refreshToken.trim()
      : undefined;
  return bodyToken ?? readCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError('Validation failed', parseResult.error.flatten().fieldErrors);
    }

    const user = await authService.register(parseResult.data);
    sendSuccess(res, { user }, 201);
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError('Validation failed', parseResult.error.flatten().fieldErrors);
    }

    const result = await authService.login(parseResult.data);
    res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, getRefreshCookieOptions());
    sendSuccess(res, result, 200);
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const candidate = extractRefreshToken(req);
    const parseResult = refreshTokenSchema.safeParse({ refreshToken: candidate });
    if (!parseResult.success) {
      throw new BadRequestError('Validation failed', parseResult.error.flatten().fieldErrors);
    }

    const tokens = await authService.refreshToken(parseResult.data.refreshToken);
    res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, getRefreshCookieOptions());
    sendSuccess(res, tokens, 200);
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const candidate = extractRefreshToken(req);
    const parseResult = refreshTokenSchema.safeParse({ refreshToken: candidate });
    if (parseResult.success) {
      await authService.logout(parseResult.data.refreshToken);
    }

    res.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      path: '/api/v1/auth',
    });
    sendSuccess(res, { message: 'Logged out successfully' }, 200);
  } catch (err) {
    next(err);
  }
}

export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('User context not available');
    }

    const user = await authService.getUserProfile(req.user.id);
    sendSuccess(res, { user }, 200);
  } catch (err) {
    next(err);
  }
}

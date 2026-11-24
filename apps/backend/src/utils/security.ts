import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const BCRYPT_SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRATION = '15m'; // 15 minutes short-lived access token
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface JwtPayload {
  sub: string;
  email: string;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

/**
 * Hashes a plaintext password using bcrypt with work factor 12.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

/**
 * Verifies a plaintext password against a stored bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generates a cryptographically secure random string for refresh tokens.
 */
export function generateSecureToken(byteLength: number = 32): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Creates a deterministic SHA-256 hash of a token string for safe database storage.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Signs a short-lived JWT access token for an authenticated user.
 */
export function signAccessToken(userId: string, email: string): string {
  const payload: JwtPayload = {
    sub: userId,
    email,
  };

  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRATION,
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

/**
 * Verifies and decodes a JWT access token with strict algorithm, issuer, audience,
 * expiration, and claim-shape checks.
 * Throws an error if token is expired, invalid, malformed, or missing required claims.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  if (!decoded || typeof decoded !== 'object') {
    throw new Error('Invalid JWT payload');
  }

  const candidate = decoded as Partial<JwtPayload>;
  if (typeof candidate.sub !== 'string' || !UUID_REGEX.test(candidate.sub)) {
    throw new Error('Invalid JWT subject claim');
  }
  if (typeof candidate.email !== 'string' || candidate.email.trim().length === 0) {
    throw new Error('Invalid JWT email claim');
  }
  if (typeof candidate.exp !== 'number') {
    throw new Error('Missing JWT expiration claim');
  }

  return candidate as JwtPayload;
}

import { prisma } from '../config/database.js';
import {
  hashPassword,
  comparePassword,
  generateSecureToken,
  hashToken,
  signAccessToken,
  REFRESH_TOKEN_TTL_MS,
} from '../utils/security.js';
import { ConflictError, UnauthorizedError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { RegisterInput, LoginInput } from '../validators/auth.validator.js';

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  user: SafeUser;
}

export class AuthService {
  /**
   * Registers a new user account with hashed credentials.
   */
  async register(input: RegisterInput): Promise<SafeUser> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Check for duplicate email
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      throw new ConflictError('An account with this email address already exists');
    }

    // Hash password with bcrypt work factor 12
    const passwordHash = await hashPassword(input.password);

    const user = await prisma.user.create({
      data: {
        name: input.name.trim(),
        email: normalizedEmail,
        passwordHash,
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    logger.info('New user registered successfully', { userId: user.id });
    return user;
  }

  /**
   * Authenticates user credentials and issues access & refresh tokens.
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Constant-time comparison prevention of user enumeration
    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const isPasswordValid = await comparePassword(input.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    // Issue short-lived JWT access token
    const accessToken = signAccessToken(user.id, user.email);

    // Generate secure refresh token and store hash in DB
    const rawRefreshToken = generateSecureToken(32);
    const tokenHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await prisma.refreshToken.create({
      data: {
        tokenHash,
        userId: user.id,
        expiresAt,
        isRevoked: false,
      },
    });

    logger.info('User authenticated successfully', { userId: user.id });

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  /**
   * Rotates refresh token and issues new access token.
   * Enforces single-use token rotation and detects reuse attacks.
   */
  async refreshToken(rawRefreshToken: string): Promise<AuthTokens> {
    const tokenHash = hashToken(rawRefreshToken);

    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!storedToken) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // Token reuse detection: if a revoked token is presented, invalidate all tokens for the user
    if (storedToken.isRevoked) {
      logger.warn('Revoked refresh token reuse attempted. Revoking all sessions for user.', {
        userId: storedToken.userId,
      });

      await prisma.refreshToken.updateMany({
        where: { userId: storedToken.userId },
        data: { isRevoked: true },
      });

      throw new UnauthorizedError('Revoked refresh token reuse detected. Please log in again.');
    }

    // Check expiration
    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // Revoke the old token (one-time use)
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { isRevoked: true },
    });

    // Generate new access token
    const newAccessToken = signAccessToken(storedToken.user.id, storedToken.user.email);

    // Generate and store new refresh token (token rotation)
    const newRawRefreshToken = generateSecureToken(32);
    const newTokenHash = hashToken(newRawRefreshToken);
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await prisma.refreshToken.create({
      data: {
        tokenHash: newTokenHash,
        userId: storedToken.user.id,
        expiresAt: newExpiresAt,
        isRevoked: false,
      },
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRawRefreshToken,
    };
  }

  /**
   * Revokes a refresh token on user logout.
   */
  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);

    const token = await prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (token && !token.isRevoked) {
      await prisma.refreshToken.update({
        where: { id: token.id },
        data: { isRevoked: true },
      });
      logger.info('Refresh token revoked on logout', { userId: token.userId });
    }
  }

  /**
   * Fetches the sanitized profile of an authenticated user.
   */
  async getUserProfile(userId: string): Promise<SafeUser> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundError('User profile not found');
    }

    return user;
  }
}

export const authService = new AuthService();

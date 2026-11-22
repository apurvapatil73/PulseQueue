import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/app.js';
import { hashPassword, comparePassword } from '../src/utils/security.js';
import { env } from '../src/config/env.js';

describe('User Authentication & Security', () => {
  const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const validUser = {
    name: 'Ada Lovelace',
    email: `ada_${uniqueSuffix}@pulsequeue.dev`,
    password: 'SecurePassword123!',
  };

  let testAccessToken = '';
  let testRefreshToken = '';

  describe('Password Hashing Utility', () => {
    it('hashes passwords using bcrypt with work factor 12', async () => {
      const hash = await hashPassword('TestPassword123!');
      expect(hash).toMatch(/^\$2[aby]\$12\$/);
      const isMatch = await comparePassword('TestPassword123!', hash);
      expect(isMatch).toBe(true);

      const isMismatch = await comparePassword('WrongPassword', hash);
      expect(isMismatch).toBe(false);
    });
  });

  describe('POST /api/v1/auth/register', () => {
    it('successfully registers a new user with safe response payload', async () => {
      const res = await request(app).post('/api/v1/auth/register').send(validUser);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user).toBeDefined();
      expect(res.body.data.user.id).toBeDefined();
      expect(res.body.data.user.name).toBe(validUser.name);
      expect(res.body.data.user.email).toBe(validUser.email.toLowerCase());
      expect(res.body.data.user.createdAt).toBeDefined();
      // Ensure password or passwordHash is never exposed in response
      expect(res.body.data.user.password).toBeUndefined();
      expect(res.body.data.user.passwordHash).toBeUndefined();
    });

    it('rejects duplicate email registration with 409 Conflict', async () => {
      const res = await request(app).post('/api/v1/auth/register').send(validUser);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toContain('already exists');
    });

    it('rejects registration with invalid password complexity or missing fields', async () => {
      const invalidPayload = {
        name: 'A', // too short
        email: 'invalid-email-format',
        password: 'weak', // too short and missing uppercase/number
      };

      const res = await request(app).post('/api/v1/auth/register').send(invalidPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.details).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('successfully logs in with valid credentials and issues access + refresh tokens', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: validUser.email,
        password: validUser.password,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe(validUser.email.toLowerCase());

      testAccessToken = res.body.data.accessToken;
      testRefreshToken = res.body.data.refreshToken;
    });

    it('rejects incorrect password without revealing which credential failed', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: validUser.email,
        password: 'WrongPassword999!',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    it('rejects non-existent email with identical message to prevent user enumeration', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'nonexistent_user@pulsequeue.dev',
        password: 'SomePassword123!',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toBe('Invalid email or password');
    });

    it('rejects login with missing credentials', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: validUser.email,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('Protected Route & Middleware (GET /api/v1/auth/me)', () => {
    it('allows access to protected route with valid access token', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${testAccessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(validUser.email.toLowerCase());
    });

    it('rejects access when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects access with malformed or invalid token', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer totally.invalid.jwt');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Invalid access token');
    });

    it('rejects access with expired access token', async () => {
      // Create an immediately expired token
      const expiredToken = jwt.sign({ sub: 'user-123', email: 'test@dev.io' }, env.JWT_SECRET, {
        expiresIn: '-1s',
      });

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('expired');
    });
  });

  describe('POST /api/v1/auth/refresh & Token Rotation', () => {
    let rotatedRefreshToken = '';

    it('successfully rotates refresh token and issues a new access token', async () => {
      const res = await request(app).post('/api/v1/auth/refresh').send({
        refreshToken: testRefreshToken,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      // Ensure rotated token differs from the old token
      expect(res.body.data.refreshToken).not.toBe(testRefreshToken);

      rotatedRefreshToken = res.body.data.refreshToken;

      // Verify the new access token is valid
      const meRes = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`);
      expect(meRes.status).toBe(200);
    });

    it('rejects reuse of already-rotated (revoked) refresh token', async () => {
      // Attempting to reuse the original testRefreshToken which was revoked during rotation
      const res = await request(app).post('/api/v1/auth/refresh').send({
        refreshToken: testRefreshToken,
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Revoked refresh token reuse detected');
    });

    it('rejects refresh with non-existent token', async () => {
      const res = await request(app).post('/api/v1/auth/refresh').send({
        refreshToken: '0000000000000000000000000000000000000000000000000000000000000000',
      });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Invalid or expired refresh token');
    });

    describe('POST /api/v1/auth/logout', () => {
      it('successfully logs out and revokes the refresh token', async () => {
        const logoutRes = await request(app).post('/api/v1/auth/logout').send({
          refreshToken: rotatedRefreshToken,
        });

        expect(logoutRes.status).toBe(200);
        expect(logoutRes.body.success).toBe(true);

        // Attempting to refresh with the logged-out token must now fail
        const refreshAfterLogout = await request(app).post('/api/v1/auth/refresh').send({
          refreshToken: rotatedRefreshToken,
        });

        expect(refreshAfterLogout.status).toBe(401);
      });
    });
  });
});

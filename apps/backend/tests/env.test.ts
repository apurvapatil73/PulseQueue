import { describe, it, expect } from 'vitest';
import { validateEnv } from '../src/config/env.js';

describe('Environment Configuration Validation', () => {
  const validBaseEnv = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://pulsequeue:pass@localhost:5432/pulsequeue?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'super_secret_jwt_key_at_least_16_chars',
  };

  it('validates a complete and correct environment configuration', () => {
    const result = validateEnv(validBaseEnv);
    expect(result.NODE_ENV).toBe('test');
    expect(result.PORT).toBe(3000);
    expect(result.DATABASE_URL).toBe(validBaseEnv.DATABASE_URL);
    expect(result.REDIS_URL).toBe(validBaseEnv.REDIS_URL);
    expect(result.JWT_SECRET).toBe(validBaseEnv.JWT_SECRET);
  });

  it('fails safely with clear error message when DATABASE_URL is missing', () => {
    const invalidEnv = { ...validBaseEnv };
    delete (invalidEnv as Record<string, unknown>).DATABASE_URL;

    expect(() => validateEnv(invalidEnv)).toThrowError(/DATABASE_URL is required/);
  });

  it('fails safely with clear error message when REDIS_URL is missing', () => {
    const invalidEnv = { ...validBaseEnv };
    delete (invalidEnv as Record<string, unknown>).REDIS_URL;

    expect(() => validateEnv(invalidEnv)).toThrowError(/REDIS_URL is required/);
  });

  it('fails safely when JWT_SECRET is shorter than 16 characters', () => {
    const invalidEnv = {
      ...validBaseEnv,
      JWT_SECRET: 'too_short',
    };

    expect(() => validateEnv(invalidEnv)).toThrowError(/at least 16 characters long/);
  });

  it('fails safely when PORT is out of valid range', () => {
    const invalidEnv = {
      ...validBaseEnv,
      PORT: '999999',
    };

    expect(() => validateEnv(invalidEnv)).toThrowError(/PORT must be a valid port number/);
  });

  it('applies default NODE_ENV and PORT when omitted', () => {
    const minimalEnv = {
      DATABASE_URL: 'postgresql://pulsequeue:pass@localhost:5432/pulsequeue',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'min_16_characters_secret_key_test',
    };

    const result = validateEnv(minimalEnv);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
  });
});

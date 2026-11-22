import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { HealthService } from '../src/services/health.service.js';
import { app } from '../src/app.js';

describe('Health Service & Endpoint', () => {
  it('returns HTTP 200 and ok status when all services are connected', async () => {
    const mockService = new HealthService(
      async () => 'connected',
      async () => 'connected',
    );

    const result = await mockService.getHealth();
    expect(result.statusCode).toBe(200);
    expect(result.report.status).toBe('ok');
    expect(result.report.services.database).toBe('connected');
    expect(result.report.services.redis).toBe('connected');
    expect(result.report.timestamp).toBeDefined();
  });

  it('returns HTTP 503 and degraded status when database is disconnected', async () => {
    const mockService = new HealthService(
      async () => 'disconnected',
      async () => 'connected',
    );

    const result = await mockService.getHealth();
    expect(result.statusCode).toBe(503);
    expect(result.report.status).toBe('degraded');
    expect(result.report.services.database).toBe('disconnected');
    expect(result.report.services.redis).toBe('connected');
  });

  it('returns HTTP 503 and degraded status when redis is disconnected', async () => {
    const mockService = new HealthService(
      async () => 'connected',
      async () => 'disconnected',
    );

    const result = await mockService.getHealth();
    expect(result.statusCode).toBe(503);
    expect(result.report.status).toBe('degraded');
    expect(result.report.services.database).toBe('connected');
    expect(result.report.services.redis).toBe('disconnected');
  });

  it('integrates with Express GET /health endpoint and returns valid schema', async () => {
    // Isolated express router using a test instance
    const testApp = express();
    const mockHealthService = new HealthService(
      async () => 'connected',
      async () => 'connected',
    );

    testApp.get('/health', async (_req, res) => {
      const { statusCode, report } = await mockHealthService.getHealth();
      res.status(statusCode).json(report);
    });

    const res = await request(testApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services).toEqual({
      database: 'connected',
      redis: 'connected',
    });
    expect(res.body.timestamp).toBeTypeOf('string');
  });

  it('tests the actual live /health route on the main app', async () => {
    const res = await request(app).get('/health');
    // Live route checks real infrastructure (if down, returns 503; if up, returns 200)
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('services');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body.services).toHaveProperty('database');
    expect(res.body.services).toHaveProperty('redis');
  });
});

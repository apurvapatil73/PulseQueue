import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { notFoundHandler } from '../src/middleware/notFound.middleware.js';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { BadRequestError, NotFoundError } from '../src/utils/errors.js';

describe('Error Handling Middleware', () => {
  const setupTestApp = () => {
    const app = express();
    app.use(express.json());

    app.get('/test-success', (_req, res) => {
      res.json({ success: true });
    });

    app.get('/test-operational-error', () => {
      throw new BadRequestError('Invalid payload parameter', { field: 'name' });
    });

    app.get('/test-not-found-error', () => {
      throw new NotFoundError('Queue with id not found');
    });

    app.get('/test-unexpected-error', () => {
      throw new Error('Database disk failure simulation');
    });

    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  };

  const testApp = setupTestApp();

  it('handles 404 for non-existent routes', async () => {
    const res = await request(testApp).get('/api/v1/non-existent-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(res.body.error.message).toContain('Route not found');
    expect(res.body.timestamp).toBeDefined();
  });

  it('handles operational AppError with custom status code and details', async () => {
    const res = await request(testApp).get('/test-operational-error');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toBe('Invalid payload parameter');
    expect(res.body.error.details).toEqual({ field: 'name' });
  });

  it('handles NotFoundError with 404 code', async () => {
    const res = await request(testApp).get('/test-not-found-error');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Queue with id not found');
  });

  it('handles unexpected errors gracefully with 500 status code', async () => {
    const res = await request(testApp).get('/test-unexpected-error');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.timestamp).toBeDefined();
  });
});

import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.middleware.js';
import { generalApiRateLimiter } from './middleware/rateLimit.middleware.js';
import { notFoundHandler } from './middleware/notFound.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';
import routes from './routes/index.js';

export interface CreateAppOptions {
  trustProxy?: boolean | number | string;
}

export function createApp(options?: CreateAppOptions): Express {
  const app = express();

  // Explicit trusted-proxy configuration (never unrestricted `true`)
  app.set('trust proxy', options?.trustProxy ?? env.TRUST_PROXY);

  // Security headers
  app.use(
    helmet({
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Strict CORS allowlist with credentials (never reflects arbitrary third-party origins)
  const allowedOrigins = new Set(env.CORS_ALLOWED_ORIGINS);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow same-origin / non-browser requests without an Origin header
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Authorization',
        'X-API-Key',
        'Content-Type',
        'Idempotency-Key',
        'Last-Event-ID',
      ],
    }),
  );

  // Tighter body limit on authentication endpoints (16 KiB) vs general API (1 MiB)
  app.use('/api/v1/auth', express.json({ limit: '16kb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // HTTP Request Logging
  app.use(requestLogger);

  // General distributed API rate limit
  app.use('/api/v1', generalApiRateLimiter);

  // Application Routes
  app.use(routes);

  // Fallthrough 404 handler
  app.use(notFoundHandler);

  // Centralised Error Handling Middleware
  app.use(errorHandler);

  return app;
}

export const app = createApp();

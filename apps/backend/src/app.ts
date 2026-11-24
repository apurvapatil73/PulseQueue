import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.middleware.js';
import { notFoundHandler } from './middleware/notFound.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';
import routes from './routes/index.js';

export function createApp(): Express {
  const app = express();

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
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Last-Event-ID'],
    }),
  );

  // Request Body Parsers
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // HTTP Request Logging
  app.use(requestLogger);

  // Application Routes
  app.use(routes);

  // Fallthrough 404 handler
  app.use(notFoundHandler);

  // Centralised Error Handling Middleware
  app.use(errorHandler);

  return app;
}

export const app = createApp();

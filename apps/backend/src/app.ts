import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestLogger } from './middleware/requestLogger.middleware.js';
import { notFoundHandler } from './middleware/notFound.middleware.js';
import { errorHandler } from './middleware/error.middleware.js';
import routes from './routes/index.js';

export function createApp(): Express {
  const app = express();

  // Security headers
  app.use(helmet());

  // Cross-Origin Resource Sharing (reflect origin + allow credentials for HttpOnly refresh cookie)
  app.use(
    cors({
      origin: true,
      credentials: true,
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

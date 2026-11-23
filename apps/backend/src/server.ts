import http from 'http';
import path from 'path';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { bullMQService } from './services/bullmq.service.js';
import { outboxReconciler } from './services/outboxReconciler.service.js';
import { realtimeEventBus } from './services/realtime.service.js';

let server: http.Server | null = null;
let isShuttingDown = false;

async function startServer(): Promise<http.Server> {
  logger.info(`Starting PulseQueue Backend API in [${env.NODE_ENV}] mode...`);

  server = http.createServer(app);

  server.listen(env.PORT, () => {
    logger.info(`PulseQueue Backend API listening on port ${env.PORT}`);
    logger.info(`Health check available at: http://localhost:${env.PORT}/health`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${env.PORT} is already in use. Exiting...`);
    } else {
      logger.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  // Attempt initial infrastructure connections (non-blocking so health probes can execute)
  connectDatabase().catch((err) => {
    logger.warn('Initial database connection failed. Server is operating in degraded mode.', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  connectRedis().catch((err) => {
    logger.warn('Initial Redis connection failed. Server is operating in degraded mode.', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Start controlled outbox reconciliation for resilient Redis dispatch recovery
  outboxReconciler.start(5000);

  return server;
}

export async function shutdown(signal: string = 'SIGTERM'): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  // Stop periodic outbox reconciler
  outboxReconciler.stop();

  // Close active SSE streams & Pub/Sub connections before closing HTTP server so shutdown never hangs
  await realtimeEventBus.closeAll();

  // Set timeout to force exit if cleanup hangs
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  // Close HTTP server to stop accepting new requests
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close((err) => {
        if (err) {
          logger.error('Error closing HTTP server', { error: err.message });
        } else {
          logger.info('HTTP server closed successfully');
        }
        resolve();
      });
    });
  }

  // Gracefully close BullMQ queues and shared BullMQ Redis connection
  await bullMQService.closeAll();

  // Gracefully close database connection
  await disconnectDatabase();

  // Gracefully close Redis connection
  await disconnectRedis();

  logger.info('PulseQueue Backend API shutdown complete. Goodbye.');
  process.exit(0);
}

// Start the server and attach process signal handlers ONLY when executed directly
const entryArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectServerRun =
  entryArg.endsWith(`${path.sep}server.js`) || entryArg.endsWith(`${path.sep}server.ts`);

if (process.env.NODE_ENV !== 'test' && isDirectServerRun) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err: Error) => {
    logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
    shutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled Promise Rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  startServer().catch((err) => {
    logger.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}

export { server, startServer };

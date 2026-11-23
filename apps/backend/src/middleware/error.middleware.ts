import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { sendError } from '../utils/response.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const isProduction = env.NODE_ENV === 'production';

  // Never attempt to send JSON headers if a streaming response (e.g. SSE) already flushed headers
  if (res.headersSent) {
    logger.warn(`Error occurred after response headers were sent: ${err.message}`, {
      method: req.method,
      url: req.originalUrl,
    });
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  // Check if it is a known operational AppError
  if (err instanceof AppError) {
    logger.warn(`Operational Error [${err.code}]: ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
      method: req.method,
      url: req.originalUrl,
      details: err.details,
    });

    sendError(res, err.message, err.statusCode, err.code, err.details);
    return;
  }

  // Handle oversized request bodies from express.json / express.urlencoded
  const httpErr = err as Error & { type?: string; status?: number; statusCode?: number };
  if (httpErr.type === 'entity.too.large' || httpErr.status === 413 || httpErr.statusCode === 413) {
    logger.warn('Request payload exceeded size limit', {
      method: req.method,
      url: req.originalUrl,
    });
    sendError(res, 'Request payload exceeds maximum allowed size', 413, 'PAYLOAD_TOO_LARGE');
    return;
  }

  // Handle SyntaxError (e.g. malformed JSON in request body)
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn('Malformed JSON body received', {
      method: req.method,
      url: req.originalUrl,
    });
    sendError(res, 'Malformed JSON payload in request body', 400, 'INVALID_JSON');
    return;
  }

  // Unexpected or unhandled internal errors
  logger.error(`Unhandled Exception: ${err.message}`, {
    name: err.name,
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
  });

  const responseMessage = isProduction
    ? 'An internal server error occurred'
    : err.message || 'An internal server error occurred';

  const details = isProduction ? undefined : { stack: err.stack };

  sendError(res, responseMessage, 500, 'INTERNAL_SERVER_ERROR', details);
}

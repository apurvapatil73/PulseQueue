import crypto from 'node:crypto';
import os from 'node:os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface InstanceIdentity {
  instanceId: string;
  hostname: string;
  pid: number;
}

const INSTANCE_HOSTNAME = os.hostname();
const INSTANCE_PID = process.pid;
const INSTANCE_ID =
  process.env.INSTANCE_ID?.trim() ||
  `pq-${INSTANCE_HOSTNAME}-${INSTANCE_PID}-${crypto.randomUUID().slice(0, 6)}`;

export function getInstanceIdentity(): InstanceIdentity {
  return {
    instanceId: INSTANCE_ID,
    hostname: INSTANCE_HOSTNAME,
    pid: INSTANCE_PID,
  };
}

interface LogContext {
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'jwt',
  'jwt_secret',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'apikey',
  'api_key',
  'api_key_secret',
  'x-api-key',
  'plaintextkey',
  'keyhash',
  'database_url',
  'redis_url',
]);

const SENSITIVE_QUERY_PATTERN =
  /([?&](?:token|access_token|refresh_token|secret|password|apikey|api_key)=)[^&\s]*/gi;

function sanitizeString(value: string): string {
  return value.replace(SENSITIVE_QUERY_PATTERN, '$1[REDACTED]');
}

function sanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitize(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

class StructuredLogger {
  private minLevel: LogLevel;

  constructor() {
    const isTest = process.env.NODE_ENV === 'test';
    const isProd = process.env.NODE_ENV === 'production';
    this.minLevel = isTest ? 'error' : isProd ? 'info' : 'debug';
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const isProd = process.env.NODE_ENV === 'production';

    const cleanContext = context ? (sanitize(context) as LogContext) : undefined;

    if (isProd) {
      const entry = {
        timestamp,
        level: level.toUpperCase(),
        instanceId: INSTANCE_ID,
        pid: INSTANCE_PID,
        message,
        ...cleanContext,
      };
      console.log(JSON.stringify(entry));
    } else {
      const prefix = `[${timestamp}] [${level.toUpperCase()}] [${INSTANCE_ID}]`;
      if (level === 'error') {
        console.error(`${prefix} ${message}`, cleanContext ? cleanContext : '');
      } else if (level === 'warn') {
        console.warn(`${prefix} ${message}`, cleanContext ? cleanContext : '');
      } else {
        console.log(`${prefix} ${message}`, cleanContext ? cleanContext : '');
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }
}

export const logger = new StructuredLogger();

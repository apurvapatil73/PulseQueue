import {
  checkDatabaseHealth,
  getDatabasePoolConfig,
  type DatabasePoolConfig,
} from '../config/database.js';
import { checkRedisHealth } from '../config/redis.js';
import { getInstanceIdentity } from '../utils/logger.js';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  services: {
    database: 'connected' | 'disconnected';
    redis: 'connected' | 'disconnected';
  };
  timestamp: string;
}

export interface LivenessReport {
  status: 'alive' | 'shutting_down';
  instanceId: string;
  pid: number;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  ready: boolean;
  shuttingDown: boolean;
  instanceId: string;
  pid: number;
  services: {
    database: 'connected' | 'disconnected';
    redis: 'connected' | 'disconnected';
  };
  pool: DatabasePoolConfig;
  timestamp: string;
}

export interface HealthCheckResult<T = HealthReport> {
  statusCode: number;
  report: T;
}

export class HealthService {
  private shuttingDown = false;

  constructor(
    private readonly dbCheck: () => Promise<'connected' | 'disconnected'> = checkDatabaseHealth,
    private readonly redisCheck: () => Promise<'connected' | 'disconnected'> = checkRedisHealth,
  ) {}

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  resetShuttingDown(): void {
    this.shuttingDown = false;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  getLiveness(): HealthCheckResult<LivenessReport> {
    const { instanceId, pid } = getInstanceIdentity();
    return {
      statusCode: this.shuttingDown ? 503 : 200,
      report: {
        status: this.shuttingDown ? 'shutting_down' : 'alive',
        instanceId,
        pid,
        uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async getReadiness(): Promise<HealthCheckResult<ReadinessReport>> {
    const { instanceId, pid } = getInstanceIdentity();
    const [databaseStatus, redisStatus] = await Promise.all([
      this.dbCheck().catch(() => 'disconnected' as const),
      this.redisCheck().catch(() => 'disconnected' as const),
    ]);

    const ready =
      !this.shuttingDown && databaseStatus === 'connected' && redisStatus === 'connected';

    return {
      statusCode: ready ? 200 : 503,
      report: {
        status: ready ? 'ready' : 'not_ready',
        ready,
        shuttingDown: this.shuttingDown,
        instanceId,
        pid,
        services: {
          database: databaseStatus,
          redis: redisStatus,
        },
        pool: getDatabasePoolConfig(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async getHealth(): Promise<HealthCheckResult> {
    const [databaseStatus, redisStatus] = await Promise.all([
      this.dbCheck().catch(() => 'disconnected' as const),
      this.redisCheck().catch(() => 'disconnected' as const),
    ]);

    const isAllHealthy =
      !this.shuttingDown && databaseStatus === 'connected' && redisStatus === 'connected';

    const report: HealthReport = {
      status: isAllHealthy ? 'ok' : 'degraded',
      services: {
        database: databaseStatus,
        redis: redisStatus,
      },
      timestamp: new Date().toISOString(),
    };

    return {
      statusCode: isAllHealthy ? 200 : 503,
      report,
    };
  }
}

export const healthService = new HealthService();

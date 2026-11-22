import { checkDatabaseHealth } from '../config/database.js';
import { checkRedisHealth } from '../config/redis.js';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  services: {
    database: 'connected' | 'disconnected';
    redis: 'connected' | 'disconnected';
  };
  timestamp: string;
}

export interface HealthCheckResult {
  statusCode: number;
  report: HealthReport;
}

export class HealthService {
  constructor(
    private readonly dbCheck: () => Promise<'connected' | 'disconnected'> = checkDatabaseHealth,
    private readonly redisCheck: () => Promise<'connected' | 'disconnected'> = checkRedisHealth,
  ) {}

  async getHealth(): Promise<HealthCheckResult> {
    const [databaseStatus, redisStatus] = await Promise.all([
      this.dbCheck().catch(() => 'disconnected' as const),
      this.redisCheck().catch(() => 'disconnected' as const),
    ]);

    const isAllHealthy = databaseStatus === 'connected' && redisStatus === 'connected';

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

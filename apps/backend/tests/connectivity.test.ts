import { describe, it, expect } from 'vitest';
import { checkDatabaseHealth } from '../src/config/database.js';
import { checkRedisHealth } from '../src/config/redis.js';

describe('Database and Redis Connectivity Checks', () => {
  it('checkDatabaseHealth returns connected or disconnected without unhandled exception', async () => {
    // Probes database with a short timeout
    const result = await checkDatabaseHealth(1500);
    expect(['connected', 'disconnected']).toContain(result);
  });

  it('checkRedisHealth returns connected or disconnected without unhandled exception', async () => {
    // Probes redis with a short timeout
    const result = await checkRedisHealth(1500);
    expect(['connected', 'disconnected']).toContain(result);
  });
});

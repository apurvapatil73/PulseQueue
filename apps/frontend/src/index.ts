/**
 * PulseQueue Frontend Application
 * Entry point placeholder prepared for Step 2+ implementation.
 */
import { PlatformHealthStatus } from '@pulsequeue/shared';

export const FRONTEND_APP_NAME = 'PulseQueue Web Dashboard';

export function initializeFrontend(): { appName: string; initialStatus: PlatformHealthStatus } {
  return {
    appName: FRONTEND_APP_NAME,
    initialStatus: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        postgres: false,
        redis: false,
      },
    },
  };
}

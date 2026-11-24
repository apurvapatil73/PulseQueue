import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  listDlqJobs,
  getDlqJob,
  replayDlqJob,
  getOrganisationMetrics,
  getOrganisationMetricsTimeseries,
  getOrganisationSchedulerMetrics,
  listOrganisationWorkers,
  listOrganisationEvents,
  triggerStalledRecovery,
} from '../controllers/monitoring.controller.js';
import { streamOrganisationEvents } from '../controllers/stream.controller.js';

/**
 * Organisation-scoped Dead-Letter Queue (DLQ) routes:
 * Mounted at /api/v1/organisations/:organisationId/dlq
 */
export const dlqRoutes = Router({ mergeParams: true });

dlqRoutes.get('/', authenticate, requireOrgRole(Role.MEMBER), listDlqJobs);
dlqRoutes.get('/:dlqId', authenticate, requireOrgRole(Role.MEMBER), getDlqJob);
dlqRoutes.post('/:dlqId/replay', authenticate, requireOrgRole(Role.ADMIN), replayDlqJob);

/**
 * Organisation-scoped Monitoring, Worker Health, Metrics & Events routes:
 * Mounted at /api/v1/organisations/:organisationId/monitoring
 */
export const monitoringRoutes = Router({ mergeParams: true });

monitoringRoutes.get('/metrics', authenticate, requireOrgRole(Role.MEMBER), getOrganisationMetrics);
monitoringRoutes.get(
  '/metrics/timeseries',
  authenticate,
  requireOrgRole(Role.MEMBER),
  getOrganisationMetricsTimeseries,
);
monitoringRoutes.get(
  '/scheduler',
  authenticate,
  requireOrgRole(Role.MEMBER),
  getOrganisationSchedulerMetrics,
);
monitoringRoutes.get(
  '/workers',
  authenticate,
  requireOrgRole(Role.MEMBER),
  listOrganisationWorkers,
);
monitoringRoutes.get('/events', authenticate, requireOrgRole(Role.MEMBER), listOrganisationEvents);
monitoringRoutes.get(
  '/stream',
  authenticate,
  requireOrgRole(Role.MEMBER),
  streamOrganisationEvents,
);
monitoringRoutes.post(
  '/recover-stalled',
  authenticate,
  requireOrgRole(Role.ADMIN),
  triggerStalledRecovery,
);

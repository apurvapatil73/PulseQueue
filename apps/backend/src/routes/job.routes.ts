import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import { jobSubmitRateLimiter } from '../middleware/rateLimit.middleware.js';
import { createJob, listQueueJobs, getJob, cancelJob } from '../controllers/job.controller.js';

/**
 * Queue-scoped job routes:
 * Mounted at /api/v1/organisations/:organisationId/queues/:queueId/jobs
 */
export const queueJobRoutes = Router({ mergeParams: true });

queueJobRoutes.post(
  '/',
  authenticate,
  requireOrgRole(Role.MEMBER, 'jobs:write'),
  jobSubmitRateLimiter,
  createJob,
);
queueJobRoutes.get('/', authenticate, requireOrgRole(Role.MEMBER, 'jobs:read'), listQueueJobs);
queueJobRoutes.get('/:jobId', authenticate, requireOrgRole(Role.MEMBER, 'jobs:read'), getJob);
queueJobRoutes.post(
  '/:jobId/cancel',
  authenticate,
  requireOrgRole(Role.ADMIN, 'jobs:cancel'),
  cancelJob,
);

/**
 * Organisation-scoped job routes:
 * Mounted at /api/v1/organisations/:organisationId/jobs
 */
export const orgJobRoutes = Router({ mergeParams: true });

orgJobRoutes.get('/:jobId', authenticate, requireOrgRole(Role.MEMBER, 'jobs:read'), getJob);
orgJobRoutes.post(
  '/:jobId/cancel',
  authenticate,
  requireOrgRole(Role.ADMIN, 'jobs:cancel'),
  cancelJob,
);

import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  createQueue,
  listQueues,
  getQueue,
  updateQueue,
  deleteQueue,
  pauseQueue,
  resumeQueue,
  getQueueStats,
} from '../controllers/queue.controller.js';

// mergeParams ensures :organisationId from the parent mount path is available to requireOrgRole
const router = Router({ mergeParams: true });

// ─── Queue CRUD ───────────────────────────────────────────────────────────────
router.post('/', authenticate, requireOrgRole(Role.ADMIN, 'queues:write'), createQueue);
router.get('/', authenticate, requireOrgRole(Role.MEMBER, 'queues:read'), listQueues);
router.get('/:queueId', authenticate, requireOrgRole(Role.MEMBER, 'queues:read'), getQueue);
router.patch('/:queueId', authenticate, requireOrgRole(Role.ADMIN, 'queues:write'), updateQueue);
router.delete('/:queueId', authenticate, requireOrgRole(Role.OWNER), deleteQueue);

// ─── Queue Controls ───────────────────────────────────────────────────────────
router.post(
  '/:queueId/pause',
  authenticate,
  requireOrgRole(Role.ADMIN, 'queues:write'),
  pauseQueue,
);
router.post(
  '/:queueId/resume',
  authenticate,
  requireOrgRole(Role.ADMIN, 'queues:write'),
  resumeQueue,
);

// ─── Queue Statistics ─────────────────────────────────────────────────────────
router.get(
  '/:queueId/stats',
  authenticate,
  requireOrgRole(Role.MEMBER, 'queues:read'),
  getQueueStats,
);

export default router;

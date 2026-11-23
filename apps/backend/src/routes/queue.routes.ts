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
router.post('/', authenticate, requireOrgRole(Role.ADMIN), createQueue);
router.get('/', authenticate, requireOrgRole(Role.MEMBER), listQueues);
router.get('/:queueId', authenticate, requireOrgRole(Role.MEMBER), getQueue);
router.patch('/:queueId', authenticate, requireOrgRole(Role.ADMIN), updateQueue);
router.delete('/:queueId', authenticate, requireOrgRole(Role.OWNER), deleteQueue);

// ─── Queue Controls ───────────────────────────────────────────────────────────
router.post('/:queueId/pause', authenticate, requireOrgRole(Role.ADMIN), pauseQueue);
router.post('/:queueId/resume', authenticate, requireOrgRole(Role.ADMIN), resumeQueue);

// ─── Queue Statistics ─────────────────────────────────────────────────────────
router.get('/:queueId/stats', authenticate, requireOrgRole(Role.MEMBER), getQueueStats);

export default router;

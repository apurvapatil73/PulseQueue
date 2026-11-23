import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  pauseSchedule,
  resumeSchedule,
  cancelSchedule,
  deleteSchedule,
  listScheduleExecutions,
  getScheduleNextRun,
} from '../controllers/schedule.controller.js';

/**
 * Organisation-scoped Schedule Management routes:
 * Mounted at /api/v1/organisations/:organisationId/schedules
 */
const router = Router({ mergeParams: true });

router.post('/', authenticate, requireOrgRole(Role.ADMIN), createSchedule);
router.get('/', authenticate, requireOrgRole(Role.MEMBER), listSchedules);
router.get('/:scheduleId', authenticate, requireOrgRole(Role.MEMBER), getSchedule);
router.patch('/:scheduleId', authenticate, requireOrgRole(Role.ADMIN), updateSchedule);
router.post('/:scheduleId/pause', authenticate, requireOrgRole(Role.ADMIN), pauseSchedule);
router.post('/:scheduleId/resume', authenticate, requireOrgRole(Role.ADMIN), resumeSchedule);
router.post('/:scheduleId/cancel', authenticate, requireOrgRole(Role.ADMIN), cancelSchedule);
router.delete('/:scheduleId', authenticate, requireOrgRole(Role.OWNER), deleteSchedule);
router.get(
  '/:scheduleId/executions',
  authenticate,
  requireOrgRole(Role.MEMBER),
  listScheduleExecutions,
);
router.get('/:scheduleId/next-run', authenticate, requireOrgRole(Role.MEMBER), getScheduleNextRun);

export default router;

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
  getScheduleStats,
  reconcileSchedules,
} from '../controllers/schedule.controller.js';

/**
 * Organisation-scoped Schedule Management routes:
 * Mounted at /api/v1/organisations/:organisationId/schedules
 */
const router = Router({ mergeParams: true });

router.post('/', authenticate, requireOrgRole(Role.ADMIN, 'schedules:write'), createSchedule);
router.get('/', authenticate, requireOrgRole(Role.MEMBER, 'schedules:read'), listSchedules);
router.post(
  '/reconcile',
  authenticate,
  requireOrgRole(Role.ADMIN, 'schedules:write'),
  reconcileSchedules,
);
router.get(
  '/:scheduleId',
  authenticate,
  requireOrgRole(Role.MEMBER, 'schedules:read'),
  getSchedule,
);
router.patch(
  '/:scheduleId',
  authenticate,
  requireOrgRole(Role.ADMIN, 'schedules:write'),
  updateSchedule,
);
router.post(
  '/:scheduleId/pause',
  authenticate,
  requireOrgRole(Role.ADMIN, 'schedules:write'),
  pauseSchedule,
);
router.post(
  '/:scheduleId/resume',
  authenticate,
  requireOrgRole(Role.ADMIN, 'schedules:write'),
  resumeSchedule,
);
router.post(
  '/:scheduleId/cancel',
  authenticate,
  requireOrgRole(Role.ADMIN, 'schedules:write'),
  cancelSchedule,
);
router.delete('/:scheduleId', authenticate, requireOrgRole(Role.OWNER), deleteSchedule);
router.get(
  '/:scheduleId/executions',
  authenticate,
  requireOrgRole(Role.MEMBER, 'schedules:read'),
  listScheduleExecutions,
);
router.get(
  '/:scheduleId/next-run',
  authenticate,
  requireOrgRole(Role.MEMBER, 'schedules:read'),
  getScheduleNextRun,
);
router.get(
  '/:scheduleId/stats',
  authenticate,
  requireOrgRole(Role.MEMBER, 'schedules:read'),
  getScheduleStats,
);

export default router;

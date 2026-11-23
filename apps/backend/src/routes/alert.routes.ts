import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  toggleAlertRule,
  deleteAlertRule,
  listAlerts,
  getAlertStats,
  getAlert,
  acknowledgeAlert,
  resolveAlert,
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../controllers/alert.controller.js';

/**
 * Organisation-scoped Alert Rules routes:
 * Mounted at /api/v1/organisations/:organisationId/alert-rules
 */
export const alertRuleRoutes = Router({ mergeParams: true });

alertRuleRoutes.get('/', authenticate, requireOrgRole(Role.MEMBER), listAlertRules);
alertRuleRoutes.get('/:ruleId', authenticate, requireOrgRole(Role.MEMBER), getAlertRule);
alertRuleRoutes.post('/', authenticate, requireOrgRole(Role.ADMIN), createAlertRule);
alertRuleRoutes.patch('/:ruleId', authenticate, requireOrgRole(Role.ADMIN), updateAlertRule);
alertRuleRoutes.patch('/:ruleId/toggle', authenticate, requireOrgRole(Role.ADMIN), toggleAlertRule);
alertRuleRoutes.delete('/:ruleId', authenticate, requireOrgRole(Role.ADMIN), deleteAlertRule);

/**
 * Organisation-scoped Alerts routes:
 * Mounted at /api/v1/organisations/:organisationId/alerts
 */
export const alertRoutes = Router({ mergeParams: true });

alertRoutes.get('/', authenticate, requireOrgRole(Role.MEMBER), listAlerts);
alertRoutes.get('/stats', authenticate, requireOrgRole(Role.MEMBER), getAlertStats);
alertRoutes.get('/:alertId', authenticate, requireOrgRole(Role.MEMBER), getAlert);
alertRoutes.post(
  '/:alertId/acknowledge',
  authenticate,
  requireOrgRole(Role.MEMBER),
  acknowledgeAlert,
);
alertRoutes.post('/:alertId/resolve', authenticate, requireOrgRole(Role.ADMIN), resolveAlert);

/**
 * Organisation-scoped In-App Notifications routes:
 * Mounted at /api/v1/organisations/:organisationId/notifications
 */
export const notificationRoutes = Router({ mergeParams: true });

notificationRoutes.get('/', authenticate, requireOrgRole(Role.MEMBER), listNotifications);
notificationRoutes.get(
  '/unread-count',
  authenticate,
  requireOrgRole(Role.MEMBER),
  getUnreadNotificationCount,
);
notificationRoutes.post(
  '/read-all',
  authenticate,
  requireOrgRole(Role.MEMBER),
  markAllNotificationsRead,
);
notificationRoutes.patch(
  '/:notificationId/read',
  authenticate,
  requireOrgRole(Role.MEMBER),
  markNotificationRead,
);

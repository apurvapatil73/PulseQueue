import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import orgRoutes from './organisation.routes.js';
import invitationRoutes from './invitation.routes.js';
import queueRoutes from './queue.routes.js';
import { queueJobRoutes, orgJobRoutes } from './job.routes.js';
import { dlqRoutes, monitoringRoutes } from './monitoring.routes.js';
import scheduleRoutes from './schedule.routes.js';
import { alertRuleRoutes, alertRoutes, notificationRoutes } from './alert.routes.js';
import { governanceRoutes } from './governance.routes.js';
import { apiKeyRoutes } from './apiKey.routes.js';

const router = Router();

// Health check endpoint
router.use('/health', healthRoutes);

// Authentication endpoints
router.use('/api/v1/auth', authRoutes);

// Queue-scoped job management endpoints (more specific path mounted before queueRoutes)
router.use('/api/v1/organisations/:organisationId/queues/:queueId/jobs', queueJobRoutes);

// Organisation-scoped queue management endpoints
router.use('/api/v1/organisations/:organisationId/queues', queueRoutes);

// Organisation-scoped job lookup & cancellation endpoints
router.use('/api/v1/organisations/:organisationId/jobs', orgJobRoutes);

// Organisation-scoped Dead-Letter Queue (DLQ) endpoints
router.use('/api/v1/organisations/:organisationId/dlq', dlqRoutes);

// Organisation-scoped Monitoring, Metrics, Worker Health & Events endpoints
router.use('/api/v1/organisations/:organisationId/monitoring', monitoringRoutes);

// Organisation-scoped Job Scheduling endpoints
router.use('/api/v1/organisations/:organisationId/schedules', scheduleRoutes);

// Organisation-scoped Alert Rules, Alerts & In-App Notifications endpoints
router.use('/api/v1/organisations/:organisationId/alert-rules', alertRuleRoutes);
router.use('/api/v1/organisations/:organisationId/alerts', alertRoutes);
router.use('/api/v1/organisations/:organisationId/notifications', notificationRoutes);

// Organisation-scoped Governance (Quotas, Backpressure, Retry Budgets & Quarantine) endpoints
router.use('/api/v1/organisations/:organisationId/governance', governanceRoutes);

// Organisation-scoped API Key management endpoints (JWT ADMIN/OWNER only)
router.use('/api/v1/organisations/:organisationId/api-keys', apiKeyRoutes);

// Organisation management endpoints
router.use('/api/v1/organisations', orgRoutes);

// Standalone invitation endpoints (accept without org context)
router.use('/api/v1/invitations', invitationRoutes);

export default router;

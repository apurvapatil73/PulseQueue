import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import orgRoutes from './organisation.routes.js';
import invitationRoutes from './invitation.routes.js';
import queueRoutes from './queue.routes.js';
import { queueJobRoutes, orgJobRoutes } from './job.routes.js';

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

// Organisation management endpoints
router.use('/api/v1/organisations', orgRoutes);

// Standalone invitation endpoints (accept without org context)
router.use('/api/v1/invitations', invitationRoutes);

export default router;

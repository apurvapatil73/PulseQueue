import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import orgRoutes from './organisation.routes.js';
import invitationRoutes from './invitation.routes.js';

const router = Router();

// Health check endpoint
router.use('/health', healthRoutes);

// Authentication endpoints
router.use('/api/v1/auth', authRoutes);

// Organisation management endpoints
router.use('/api/v1/organisations', orgRoutes);

// Standalone invitation endpoints (accept without org context)
router.use('/api/v1/invitations', invitationRoutes);

export default router;

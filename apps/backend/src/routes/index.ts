import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';

const router = Router();

// Health check endpoint
router.use('/health', healthRoutes);

// Authentication endpoints
router.use('/api/v1/auth', authRoutes);

export default router;

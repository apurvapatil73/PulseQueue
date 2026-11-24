import { Router } from 'express';
import { getHealth } from '../controllers/health.controller.js';
import { schedulerMetricsRegistry } from '../services/schedulerMetrics.service.js';
import { sendSuccess } from '../utils/response.js';

const router = Router();

router.get('/', getHealth);

/**
 * Privacy-safe global aggregate scheduler metrics (bounded labels only; zero tenant data).
 */
router.get('/scheduler', (_req, res) => {
  sendSuccess(res, { scheduler: schedulerMetricsRegistry.getGlobalSnapshot() });
});

export default router;

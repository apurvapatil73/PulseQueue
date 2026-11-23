import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { acceptInvitation } from '../controllers/organisation.controller.js';

const router = Router();

// POST /api/v1/invitations/accept
router.post('/accept', authenticate, acceptInvitation);

export default router;

import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from '../controllers/apiKey.controller.js';

/**
 * Organisation-scoped API key management routes (JWT ADMIN/OWNER only — API keys cannot manage keys):
 * Mounted at /api/v1/organisations/:organisationId/api-keys
 */
export const apiKeyRoutes = Router({ mergeParams: true });

apiKeyRoutes.post('/', authenticate, requireOrgRole(Role.ADMIN), createApiKey);
apiKeyRoutes.get('/', authenticate, requireOrgRole(Role.ADMIN), listApiKeys);
apiKeyRoutes.post('/:apiKeyId/revoke', authenticate, requireOrgRole(Role.ADMIN), revokeApiKey);
apiKeyRoutes.post('/:apiKeyId/rotate', authenticate, requireOrgRole(Role.ADMIN), rotateApiKey);

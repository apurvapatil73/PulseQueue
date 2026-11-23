import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  getOrganisationGovernance,
  updateOrganisationQuotas,
} from '../controllers/governance.controller.js';

/**
 * Organisation-scoped Governance, Quotas, Backpressure, Retry Budgets & Quarantine routes:
 * Mounted at /api/v1/organisations/:organisationId/governance
 */
export const governanceRoutes = Router({ mergeParams: true });

governanceRoutes.get('/', authenticate, requireOrgRole(Role.MEMBER), getOrganisationGovernance);
governanceRoutes.patch(
  '/quotas',
  authenticate,
  requireOrgRole(Role.ADMIN),
  updateOrganisationQuotas,
);

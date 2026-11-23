import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole } from '../middleware/rbac.middleware.js';
import {
  createOrg,
  listOrgs,
  getOrg,
  updateOrg,
  deleteOrg,
  listMembers,
  updateMemberRole,
  transferOwnership,
  removeMember,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from '../controllers/organisation.controller.js';

const router = Router();

// ─── Organisation CRUD ────────────────────────────────────────────────────────
router.post('/', authenticate, createOrg);
router.get('/', authenticate, listOrgs);
router.get('/:organisationId', authenticate, requireOrgRole(Role.MEMBER), getOrg);
router.patch('/:organisationId', authenticate, requireOrgRole(Role.ADMIN), updateOrg);
router.delete('/:organisationId', authenticate, requireOrgRole(Role.OWNER), deleteOrg);

// ─── Ownership Transfer (Owner only) ──────────────────────────────────────────
router.post(
  '/:organisationId/transfer-ownership',
  authenticate,
  requireOrgRole(Role.OWNER),
  transferOwnership,
);

// ─── Member Management ────────────────────────────────────────────────────────
router.get('/:organisationId/members', authenticate, requireOrgRole(Role.MEMBER), listMembers);
router.patch(
  '/:organisationId/members/:userId/role',
  authenticate,
  requireOrgRole(Role.ADMIN),
  updateMemberRole,
);
router.delete(
  '/:organisationId/members/:userId',
  authenticate,
  requireOrgRole(Role.ADMIN),
  removeMember,
);

// ─── Invitations ──────────────────────────────────────────────────────────────
router.post(
  '/:organisationId/invitations',
  authenticate,
  requireOrgRole(Role.ADMIN),
  createInvitation,
);
router.get(
  '/:organisationId/invitations',
  authenticate,
  requireOrgRole(Role.ADMIN),
  listInvitations,
);
router.delete(
  '/:organisationId/invitations/:invitationId',
  authenticate,
  requireOrgRole(Role.ADMIN),
  revokeInvitation,
);

export default router;

import { Role, InvitationStatus } from '@prisma/client';
import { prisma as db } from '../config/database.js';
import { env } from '../config/env.js';
import { generateSecureToken, hashToken } from '../utils/security.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { uuidSchema } from '../validators/organisation.validator.js';
import { invitationDeliveryService } from './invitationDelivery.service.js';
import type { RequestMembership } from '../types/express.js';

/** How long an invitation remains valid (7 days). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Safe organisation shape returned to callers. */
export interface OrganisationView {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  role?: Role;
}

/** Safe membership shape returned to callers (never exposes passwordHash). */
export interface MemberView {
  id: string;
  role: Role;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

/** Safe invitation shape — NEVER includes tokenHash or raw token. */
export interface InvitationView {
  id: string;
  organisationId: string;
  invitedEmail: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: {
    id: string;
    name: string;
    email: string;
  };
}

export interface CreateInvitationResult {
  invitation: InvitationView;
  /** Only populated outside production for local development and automated testing. */
  token?: string;
}

export class OrganisationService {
  // ─── Organisation CRUD ───────────────────────────────────────────────────

  async create(userId: string, name: string): Promise<OrganisationView> {
    const trimmedName = name.trim();

    const org = await db.$transaction(async (tx) => {
      const organisation = await tx.organisation.create({
        data: { name: trimmedName },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });

      await tx.membership.create({
        data: {
          userId,
          organisationId: organisation.id,
          role: Role.OWNER,
        },
      });

      return organisation;
    });

    logger.info('Organisation created', { organisationId: org.id, userId });
    return { ...org, role: Role.OWNER };
  }

  async listForUser(userId: string): Promise<OrganisationView[]> {
    const memberships = await db.membership.findMany({
      where: { userId },
      include: {
        organisation: {
          select: { id: true, name: true, createdAt: true, updatedAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      ...m.organisation,
      role: m.role,
    }));
  }

  async getById(orgId: string, role?: Role): Promise<OrganisationView> {
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    if (!org) {
      throw new NotFoundError('Organisation not found');
    }

    return role ? { ...org, role } : org;
  }

  async update(orgId: string, name: string): Promise<OrganisationView> {
    const org = await db.organisation.update({
      where: { id: orgId },
      data: { name: name.trim() },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    logger.info('Organisation updated', { organisationId: orgId });
    return org;
  }

  async delete(orgId: string): Promise<void> {
    // Cascade deletes memberships and invitations via FK constraints
    await db.organisation.delete({ where: { id: orgId } });
    logger.info('Organisation deleted', { organisationId: orgId });
  }

  // ─── Member Management ───────────────────────────────────────────────────

  async listMembers(orgId: string): Promise<MemberView[]> {
    const memberships = await db.membership.findMany({
      where: { organisationId: orgId },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: m.user,
    }));
  }

  async updateMemberRole(
    orgId: string,
    targetUserId: string,
    newRole: Role,
    requestor: RequestMembership,
  ): Promise<MemberView> {
    if (!uuidSchema.safeParse(targetUserId).success) {
      throw new NotFoundError('Member not found in this organisation');
    }

    // Prevent direct assignment of OWNER role — ownership transfer is a dedicated flow
    if (newRole === Role.OWNER) {
      throw new ForbiddenError(
        'Cannot assign OWNER role directly. Use ownership transfer instead.',
      );
    }

    // Only Owners can promote members to Admin or modify Admin/Owner roles
    if (requestor.role !== Role.OWNER) {
      throw new ForbiddenError('Only Owners can change member roles');
    }

    const targetMembership = await db.membership.findUnique({
      where: {
        userId_organisationId: {
          userId: targetUserId,
          organisationId: orgId,
        },
      },
    });

    if (!targetMembership) {
      throw new NotFoundError('Member not found in this organisation');
    }

    // Protect the last Owner from being demoted
    if (targetMembership.role === Role.OWNER) {
      const ownerCount = await db.membership.count({
        where: { organisationId: orgId, role: Role.OWNER },
      });

      if (ownerCount <= 1) {
        throw new BadRequestError(
          'Cannot demote the last Owner. Transfer ownership before changing role.',
        );
      }
    }

    const updated = await db.membership.update({
      where: {
        userId_organisationId: {
          userId: targetUserId,
          organisationId: orgId,
        },
      },
      data: { role: newRole },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    logger.info('Member role updated', {
      organisationId: orgId,
      targetUserId,
      newRole,
      updatedBy: requestor.userId,
    });

    return {
      id: updated.id,
      role: updated.role,
      createdAt: updated.createdAt,
      user: updated.user,
    };
  }

  async transferOwnership(
    orgId: string,
    targetUserId: string,
    currentOwnerId: string,
  ): Promise<{ organisationId: string; newOwnerId: string; previousOwnerId: string }> {
    if (!uuidSchema.safeParse(targetUserId).success) {
      throw new NotFoundError('Target user is not a member of this organisation');
    }

    if (targetUserId === currentOwnerId) {
      throw new BadRequestError('You are already an Owner of this organisation');
    }

    const targetMembership = await db.membership.findUnique({
      where: {
        userId_organisationId: {
          userId: targetUserId,
          organisationId: orgId,
        },
      },
    });

    if (!targetMembership) {
      throw new NotFoundError('Target user is not a member of this organisation');
    }

    if (targetMembership.role === Role.OWNER) {
      throw new BadRequestError('Target user is already an Owner of this organisation');
    }

    await db.$transaction([
      db.membership.update({
        where: {
          userId_organisationId: {
            userId: targetUserId,
            organisationId: orgId,
          },
        },
        data: { role: Role.OWNER },
      }),
      db.membership.update({
        where: {
          userId_organisationId: {
            userId: currentOwnerId,
            organisationId: orgId,
          },
        },
        data: { role: Role.ADMIN },
      }),
    ]);

    logger.info('Organisation ownership transferred', {
      organisationId: orgId,
      previousOwnerId: currentOwnerId,
      newOwnerId: targetUserId,
    });

    return {
      organisationId: orgId,
      newOwnerId: targetUserId,
      previousOwnerId: currentOwnerId,
    };
  }

  async removeMember(
    orgId: string,
    targetUserId: string,
    requestor: RequestMembership,
  ): Promise<void> {
    if (!uuidSchema.safeParse(targetUserId).success) {
      throw new NotFoundError('Member not found in this organisation');
    }

    const targetMembership = await db.membership.findUnique({
      where: {
        userId_organisationId: {
          userId: targetUserId,
          organisationId: orgId,
        },
      },
    });

    if (!targetMembership) {
      throw new NotFoundError('Member not found in this organisation');
    }

    // RBAC hierarchy check for member removal
    if (targetMembership.role === Role.OWNER) {
      if (requestor.role !== Role.OWNER) {
        throw new ForbiddenError('Only Owners can remove an Owner');
      }

      const ownerCount = await db.membership.count({
        where: { organisationId: orgId, role: Role.OWNER },
      });

      if (ownerCount <= 1) {
        throw new BadRequestError(
          'Cannot remove the last Owner. Transfer ownership before leaving.',
        );
      }
    } else if (
      targetMembership.role === Role.ADMIN &&
      requestor.role !== Role.OWNER &&
      targetUserId !== requestor.userId
    ) {
      throw new ForbiddenError('Only Owners can remove an Admin');
    }

    await db.membership.delete({
      where: {
        userId_organisationId: {
          userId: targetUserId,
          organisationId: orgId,
        },
      },
    });

    logger.info('Member removed', {
      organisationId: orgId,
      targetUserId,
      removedBy: requestor.userId,
    });
  }

  // ─── Invitation System ───────────────────────────────────────────────────

  async createInvitation(
    orgId: string,
    requestor: RequestMembership,
    email: string,
    role: Role,
  ): Promise<CreateInvitationResult> {
    const normalizedEmail = email.trim().toLowerCase();

    // Prevent role escalation via invitations
    if (role === Role.OWNER) {
      throw new ForbiddenError('Cannot invite a user with OWNER role');
    }

    if (role === Role.ADMIN && requestor.role !== Role.OWNER) {
      throw new ForbiddenError('Only Owners can invite users with ADMIN role');
    }

    const now = new Date();

    // Lazily expire any stale PENDING invitations for this org + email
    await db.invitation.updateMany({
      where: {
        organisationId: orgId,
        invitedEmail: normalizedEmail,
        status: InvitationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: InvitationStatus.EXPIRED },
    });

    // Prevent duplicate active PENDING invitations
    const existingPending = await db.invitation.findFirst({
      where: {
        organisationId: orgId,
        invitedEmail: normalizedEmail,
        status: InvitationStatus.PENDING,
      },
    });

    if (existingPending) {
      throw new ConflictError('A pending invitation already exists for this email address');
    }

    // Check if the invited email already belongs to a member of this organisation
    const existingUser = await db.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existingUser) {
      const alreadyMember = await db.membership.findUnique({
        where: {
          userId_organisationId: {
            userId: existingUser.id,
            organisationId: orgId,
          },
        },
      });

      if (alreadyMember) {
        throw new ConflictError('This user is already a member of the organisation');
      }
    }

    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await db.invitation.create({
      data: {
        organisationId: orgId,
        invitedEmail: normalizedEmail,
        role,
        tokenHash,
        expiresAt,
        invitedById: requestor.userId,
      },
      include: {
        organisation: { select: { name: true } },
        invitedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Dispatch through the delivery abstraction (ready for SMTP/SES/Resend later)
    await invitationDeliveryService.deliverInvitation({
      invitationId: invitation.id,
      organisationId: orgId,
      organisationName: invitation.organisation.name,
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      invitedByName: invitation.invitedBy.name,
      expiresAt: invitation.expiresAt,
      rawToken,
    });

    logger.info('Invitation created', {
      invitationId: invitation.id,
      organisationId: orgId,
      invitedEmail: normalizedEmail,
      role,
      invitedById: requestor.userId,
    });

    const view: InvitationView = {
      id: invitation.id,
      organisationId: invitation.organisationId,
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      invitedBy: invitation.invitedBy,
    };

    // Never expose raw invitation tokens in production API responses
    if (env.NODE_ENV === 'production') {
      return { invitation: view };
    }

    return { invitation: view, token: rawToken };
  }

  async listInvitations(orgId: string): Promise<InvitationView[]> {
    const now = new Date();

    // Keep expired invitation statuses accurate for this organisation
    await db.invitation.updateMany({
      where: {
        organisationId: orgId,
        status: InvitationStatus.PENDING,
        expiresAt: { lte: now },
      },
      data: { status: InvitationStatus.EXPIRED },
    });

    const invitations = await db.invitation.findMany({
      where: { organisationId: orgId },
      include: {
        invitedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Strip tokenHash — never expose it
    return invitations.map((inv) => ({
      id: inv.id,
      organisationId: inv.organisationId,
      invitedEmail: inv.invitedEmail,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      invitedBy: inv.invitedBy,
    }));
  }

  async acceptInvitation(
    rawToken: string,
    acceptingUserId: string,
  ): Promise<{ organisationId: string; role: Role; membershipId: string }> {
    const user = await db.user.findUnique({
      where: { id: acceptingUserId },
      select: { id: true, email: true },
    });

    if (!user) {
      throw new UnauthorizedError('Authenticated user account not found');
    }

    const tokenHash = hashToken(rawToken);

    const invitation = await db.invitation.findUnique({
      where: { tokenHash },
    });

    if (!invitation) {
      throw new NotFoundError('Invalid invitation token');
    }

    if (invitation.status === InvitationStatus.REVOKED) {
      throw new BadRequestError('Invitation has been revoked');
    }

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new BadRequestError('Invitation has already been accepted');
    }

    if (invitation.status === InvitationStatus.EXPIRED || invitation.expiresAt <= new Date()) {
      if (invitation.status === InvitationStatus.PENDING) {
        await db.invitation.update({
          where: { id: invitation.id },
          data: { status: InvitationStatus.EXPIRED },
        });
      }
      throw new BadRequestError('Invitation has expired');
    }

    // Verify accepting user's verified email matches the invited email
    if (invitation.invitedEmail.toLowerCase() !== user.email.toLowerCase()) {
      throw new ForbiddenError('This invitation was sent to a different email address');
    }

    // Check if already a member
    const existingMembership = await db.membership.findUnique({
      where: {
        userId_organisationId: {
          userId: user.id,
          organisationId: invitation.organisationId,
        },
      },
    });

    if (existingMembership) {
      throw new ConflictError('You are already a member of this organisation');
    }

    // Atomically mark invitation ACCEPTED (guarded on status=PENDING to prevent race reuse)
    // and create the organisation membership
    const membership = await db.$transaction(async (tx) => {
      const updatedCount = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          status: InvitationStatus.PENDING,
        },
        data: { status: InvitationStatus.ACCEPTED },
      });

      if (updatedCount.count !== 1) {
        throw new BadRequestError('Invitation is no longer valid');
      }

      return tx.membership.create({
        data: {
          userId: user.id,
          organisationId: invitation.organisationId,
          role: invitation.role,
        },
      });
    });

    logger.info('Invitation accepted', {
      invitationId: invitation.id,
      organisationId: invitation.organisationId,
      userId: user.id,
      role: membership.role,
    });

    return {
      organisationId: membership.organisationId,
      role: membership.role,
      membershipId: membership.id,
    };
  }

  async revokeInvitation(orgId: string, invitationId: string): Promise<void> {
    if (!uuidSchema.safeParse(invitationId).success) {
      throw new NotFoundError('Invitation not found');
    }

    const invitation = await db.invitation.findUnique({
      where: { id: invitationId },
    });

    // Strict tenant scoping: reject invitations belonging to another organisation with 404
    if (!invitation || invitation.organisationId !== orgId) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new BadRequestError('Only pending invitations can be revoked');
    }

    await db.invitation.update({
      where: { id: invitationId },
      data: { status: InvitationStatus.REVOKED },
    });

    logger.info('Invitation revoked', { invitationId, organisationId: orgId });
  }
}

export const organisationService = new OrganisationService();

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { hashToken } from '../src/utils/security.js';
import {
  invitationDeliveryService,
  type InvitationDeliveryPayload,
} from '../src/services/invitationDelivery.service.js';

interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
  accessToken: string;
}

async function createAndLoginUser(prefix: string, suffix: string): Promise<TestUser> {
  const email = `${prefix}_${suffix}@pulsequeue.dev`;
  const password = 'SecurePassword123!';
  const name = `${prefix.toUpperCase()} User`;

  const regRes = await request(app).post('/api/v1/auth/register').send({ name, email, password });
  expect(regRes.status).toBe(201);

  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(loginRes.status).toBe(200);

  return {
    id: regRes.body.data.user.id,
    name,
    email: email.toLowerCase(),
    password,
    accessToken: loginRes.body.data.accessToken,
  };
}

describe('Multi-Tenant Organisation Management, RBAC & Invitations (Step 3.2)', () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const deliveredPayloads: InvitationDeliveryPayload[] = [];

  let ownerA: TestUser;
  let adminA: TestUser;
  let memberA: TestUser;
  let extraMemberA: TestUser;
  let ownerB: TestUser;

  let orgAId = '';
  let orgBId = '';
  let orgBInvitationId = '';

  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    // Capture invitation delivery calls via the delivery service abstraction
    invitationDeliveryService.setProvider({
      async sendInvitation(payload: InvitationDeliveryPayload): Promise<void> {
        deliveredPayloads.push(payload);
      },
    });

    ownerA = await createAndLoginUser('owner_a', suffix);
    adminA = await createAndLoginUser('admin_a', suffix);
    memberA = await createAndLoginUser('member_a', suffix);
    extraMemberA = await createAndLoginUser('extra_a', suffix);
    ownerB = await createAndLoginUser('owner_b', suffix);

    createdUserIds.push(ownerA.id, adminA.id, memberA.id, extraMemberA.id, ownerB.id);
  }, 60_000);

  afterAll(async () => {
    // Clean up test organisations and test users without resetting database
    if (createdOrgIds.length > 0) {
      await prisma.organisation.deleteMany({
        where: { id: { in: createdOrgIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
  }, 20_000);

  // ─── 1. Unauthenticated Requests ──────────────────────────────────────────

  describe('Authentication Enforcement', () => {
    it('rejects unauthenticated organisation and invitation requests with 401', async () => {
      const fakeUuid = '00000000-0000-4000-8000-000000000001';

      const responses = await Promise.all([
        request(app).post('/api/v1/organisations').send({ name: 'Unauth Org' }),
        request(app).get('/api/v1/organisations'),
        request(app).get(`/api/v1/organisations/${fakeUuid}`),
        request(app).patch(`/api/v1/organisations/${fakeUuid}`).send({ name: 'Hack' }),
        request(app).delete(`/api/v1/organisations/${fakeUuid}`),
        request(app).get(`/api/v1/organisations/${fakeUuid}/members`),
        request(app).post(`/api/v1/organisations/${fakeUuid}/invitations`).send({
          email: 'x@example.com',
          role: 'MEMBER',
        }),
        request(app).post('/api/v1/invitations/accept').send({ token: 'some-token' }),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    });
  });

  // ─── 2. Organisation Creation & Listing ───────────────────────────────────

  describe('Organisation Creation & Listing', () => {
    it('creates an organisation and automatically assigns the creator as OWNER', async () => {
      const res = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Acme Robotics' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.organisation.id).toBeDefined();
      expect(res.body.data.organisation.name).toBe('Acme Robotics');
      expect(res.body.data.organisation.role).toBe('OWNER');

      orgAId = res.body.data.organisation.id;
      createdOrgIds.push(orgAId);

      // Verify directly in PostgreSQL
      const dbMembership = await prisma.membership.findUnique({
        where: {
          userId_organisationId: {
            userId: ownerA.id,
            organisationId: orgAId,
          },
        },
      });
      expect(dbMembership).not.toBeNull();
      expect(dbMembership?.role).toBe('OWNER');
    });

    it('rejects organisation creation with invalid Zod payload', async () => {
      const res = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'A' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('creates a second isolated organisation for Owner B', async () => {
      const res = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ name: 'Beta Systems' });

      expect(res.status).toBe(201);
      orgBId = res.body.data.organisation.id;
      createdOrgIds.push(orgBId);
    });

    it('lists only organisations the authenticated user belongs to', async () => {
      const resA = await request(app)
        .get('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerA.accessToken}`);

      expect(resA.status).toBe(200);
      const idsA = resA.body.data.organisations.map((o: { id: string }) => o.id);
      expect(idsA).toContain(orgAId);
      expect(idsA).not.toContain(orgBId);

      const resB = await request(app)
        .get('/api/v1/organisations')
        .set('Authorization', `Bearer ${ownerB.accessToken}`);

      expect(resB.status).toBe(200);
      const idsB = resB.body.data.organisations.map((o: { id: string }) => o.id);
      expect(idsB).toContain(orgBId);
      expect(idsB).not.toContain(orgAId);
    });

    it('supports a single user belonging to multiple organisations with distinct per-org roles', async () => {
      // Owner B invites Owner A as a MEMBER of Org B
      const inviteRes = await request(app)
        .post(`/api/v1/organisations/${orgBId}/invitations`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ email: memberA.email, role: 'MEMBER' });
      expect(inviteRes.status).toBe(201);

      const acceptRes = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ token: inviteRes.body.data.token });
      expect(acceptRes.status).toBe(200);

      // memberA creates their own Org C (where memberA is OWNER)
      const orgCRes = await request(app)
        .post('/api/v1/organisations')
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ name: 'Member Personal Org' });
      expect(orgCRes.status).toBe(201);
      const orgCId = orgCRes.body.data.organisation.id;
      createdOrgIds.push(orgCId);

      // memberA now belongs to both Org B (MEMBER) and Org C (OWNER)
      const listRes = await request(app)
        .get('/api/v1/organisations')
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(listRes.status).toBe(200);
      const orgs = listRes.body.data.organisations as Array<{ id: string; role: string }>;
      expect(orgs.find((o) => o.id === orgBId)?.role).toBe('MEMBER');
      expect(orgs.find((o) => o.id === orgCId)?.role).toBe('OWNER');

      // memberA is OWNER in Org C so can update Org C, but is only MEMBER in Org B so gets 403 on Org B
      const patchOrgC = await request(app)
        .patch(`/api/v1/organisations/${orgCId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ name: 'Member Personal Org Renamed' });
      expect(patchOrgC.status).toBe(200);

      const patchOrgB = await request(app)
        .patch(`/api/v1/organisations/${orgBId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ name: 'Unauthorized Rename' });
      expect(patchOrgB.status).toBe(403);

      // Clean up temporary Org B membership & Org C
      const removeFromB = await request(app)
        .delete(`/api/v1/organisations/${orgBId}/members/${memberA.id}`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`);
      expect(removeFromB.status).toBe(200);

      const deleteOrgC = await request(app)
        .delete(`/api/v1/organisations/${orgCId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(deleteOrgC.status).toBe(200);
    });

    it('returns 404 for malformed organisation UUID instead of 500', async () => {
      const res = await request(app)
        .get('/api/v1/organisations/not-a-valid-uuid')
        .set('Authorization', `Bearer ${ownerA.accessToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── 3. Invitation System & Lifecycle ─────────────────────────────────────

  describe('Invitation Workflow & Security', () => {
    let adminInviteToken = '';
    let memberInviteToken = '';
    let revocableInviteId = '';
    let revocableInviteToken = '';

    it('allows OWNER to invite a user as ADMIN, hashes token in DB, and dispatches delivery', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: adminA.email, role: 'ADMIN' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invitation.invitedEmail).toBe(adminA.email);
      expect(res.body.data.invitation.role).toBe('ADMIN');
      expect(res.body.data.invitation.status).toBe('PENDING');
      expect(res.body.data.invitation.tokenHash).toBeUndefined();
      expect(res.body.data.token).toBeDefined();

      adminInviteToken = res.body.data.token;

      // Verify only SHA-256 hash is stored in DB (never raw token)
      const dbInvite = await prisma.invitation.findUnique({
        where: { id: res.body.data.invitation.id },
      });
      expect(dbInvite).not.toBeNull();
      expect(dbInvite?.tokenHash).toBe(hashToken(adminInviteToken));
      expect(dbInvite?.tokenHash).not.toBe(adminInviteToken);

      // Verify delivery abstraction was called
      expect(deliveredPayloads.some((p) => p.invitationId === res.body.data.invitation.id)).toBe(
        true,
      );
    });

    it('prevents inviting a user with OWNER role (403)', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: 'owner_escalate@pulsequeue.dev', role: 'OWNER' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('prevents duplicate pending invitations for the same email (409)', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: adminA.email, role: 'MEMBER' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    });

    it('rejects invitation acceptance by a user with a different email (403)', async () => {
      const res = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ token: adminInviteToken });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('accepts invitation for matching email and creates membership', async () => {
      const res = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ token: adminInviteToken });

      expect(res.status).toBe(200);
      expect(res.body.data.membership.organisationId).toBe(orgAId);
      expect(res.body.data.membership.role).toBe('ADMIN');
    });

    it('rejects reuse of an already-accepted invitation token (400)', async () => {
      const res = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ token: adminInviteToken });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('already been accepted');
    });

    it('rejects inviting a user who is already a member (409)', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: adminA.email, role: 'MEMBER' });

      expect(res.status).toBe(409);
    });

    it('allows ADMIN to invite a MEMBER, but forbids ADMIN from inviting an ADMIN (403)', async () => {
      const forbiddenRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ email: memberA.email, role: 'ADMIN' });

      expect(forbiddenRes.status).toBe(403);

      const allowedRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ email: memberA.email, role: 'MEMBER' });

      expect(allowedRes.status).toBe(201);
      memberInviteToken = allowedRes.body.data.token;

      const acceptRes = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ token: memberInviteToken });

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.data.membership.role).toBe('MEMBER');
    });

    it('forbids MEMBER from creating or listing invitations (403)', async () => {
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ email: extraMemberA.email, role: 'MEMBER' });
      expect(createRes.status).toBe(403);

      const listRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(listRes.status).toBe(403);
    });

    it('lists invitations for ADMIN/OWNER without exposing tokenHash or raw token', async () => {
      const res = await request(app)
        .get(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.invitations)).toBe(true);
      expect(res.body.data.invitations.length).toBeGreaterThanOrEqual(2);
      for (const inv of res.body.data.invitations) {
        expect(inv.tokenHash).toBeUndefined();
        expect(inv.token).toBeUndefined();
      }
    });

    it('rejects invalid invitation token with 404', async () => {
      const res = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${extraMemberA.accessToken}`)
        .send({ token: '000000000000000000000000000000000000000000000000000000000000dead' });

      expect(res.status).toBe(404);
    });

    it('supports revoking a pending invitation and rejects accepting the revoked token', async () => {
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ email: extraMemberA.email, role: 'MEMBER' });

      expect(createRes.status).toBe(201);
      revocableInviteId = createRes.body.data.invitation.id;
      revocableInviteToken = createRes.body.data.token;

      // MEMBER cannot revoke
      const memberRevokeRes = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/invitations/${revocableInviteId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(memberRevokeRes.status).toBe(403);

      // ADMIN can revoke
      const revokeRes = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/invitations/${revocableInviteId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(revokeRes.status).toBe(200);

      // Accepting revoked token must fail
      const acceptRevokedRes = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${extraMemberA.accessToken}`)
        .send({ token: revocableInviteToken });
      expect(acceptRevokedRes.status).toBe(400);
      expect(acceptRevokedRes.body.error.message).toContain('revoked');
    });

    it('allows re-inviting after revocation and rejects expired invitations', async () => {
      // Re-invite extraMemberA after prior revocation
      const createRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: extraMemberA.email, role: 'MEMBER' });

      expect(createRes.status).toBe(201);
      const expiredInviteId = createRes.body.data.invitation.id;
      const expiredToken = createRes.body.data.token;

      // Force expiry in DB
      await prisma.invitation.update({
        where: { id: expiredInviteId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const acceptExpiredRes = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${extraMemberA.accessToken}`)
        .send({ token: expiredToken });

      expect(acceptExpiredRes.status).toBe(400);
      expect(acceptExpiredRes.body.error.message).toContain('expired');

      // Confirm DB status transitioned to EXPIRED
      const dbInvite = await prisma.invitation.findUnique({ where: { id: expiredInviteId } });
      expect(dbInvite?.status).toBe('EXPIRED');

      // Can invite again after expiry and accept normally
      const freshRes = await request(app)
        .post(`/api/v1/organisations/${orgAId}/invitations`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ email: extraMemberA.email, role: 'MEMBER' });
      expect(freshRes.status).toBe(201);

      const acceptFreshRes = await request(app)
        .post('/api/v1/invitations/accept')
        .set('Authorization', `Bearer ${extraMemberA.accessToken}`)
        .send({ token: freshRes.body.data.token });
      expect(acceptFreshRes.status).toBe(200);
    });
  });

  // ─── 4. Organisation Update, Member Management & RBAC ─────────────────────

  describe('Organisation Update & RBAC Member Management', () => {
    it('allows MEMBER to view organisation and members without exposing passwordHash', async () => {
      const orgRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(orgRes.status).toBe(200);
      expect(orgRes.body.data.organisation.role).toBe('MEMBER');

      const membersRes = await request(app)
        .get(`/api/v1/organisations/${orgAId}/members`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(membersRes.status).toBe(200);
      expect(membersRes.body.data.members.length).toBe(4);
      for (const m of membersRes.body.data.members) {
        expect(m.user.passwordHash).toBeUndefined();
      }
    });

    it('enforces update permissions: OWNER and ADMIN allowed, MEMBER forbidden (even with fake role body)', async () => {
      const memberRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .set('X-Role', 'OWNER')
        .send({ name: 'Hacked Name', role: 'OWNER' });
      expect(memberRes.status).toBe(403);

      const adminRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ name: 'Acme Robotics Updated by Admin' });
      expect(adminRes.status).toBe(200);
      expect(adminRes.body.data.organisation.name).toBe('Acme Robotics Updated by Admin');

      const ownerRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ name: 'Acme Robotics HQ' });
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.data.organisation.name).toBe('Acme Robotics HQ');
    });

    it('prevents role escalation: MEMBER and ADMIN cannot promote members or assign OWNER', async () => {
      // MEMBER tries to promote self to ADMIN
      const memberEscalate = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${memberA.id}/role`)
        .set('Authorization', `Bearer ${memberA.accessToken}`)
        .send({ role: 'ADMIN' });
      expect(memberEscalate.status).toBe(403);

      // ADMIN tries to promote MEMBER to ADMIN (only Owners can promote to Admin)
      const adminPromote = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${memberA.id}/role`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ role: 'ADMIN' });
      expect(adminPromote.status).toBe(403);

      // ADMIN tries to promote self to OWNER
      const adminToOwner = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${adminA.id}/role`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ role: 'OWNER' });
      expect(adminToOwner.status).toBe(403);

      // OWNER tries to assign OWNER directly via role endpoint (must use ownership transfer)
      const ownerDirectAssign = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${adminA.id}/role`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ role: 'OWNER' });
      expect(ownerDirectAssign.status).toBe(403);
    });

    it('allows OWNER to promote MEMBER to ADMIN and demote ADMIN to MEMBER', async () => {
      const promoteRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${memberA.id}/role`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ role: 'ADMIN' });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.data.member.role).toBe('ADMIN');

      const demoteRes = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${memberA.id}/role`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ role: 'MEMBER' });
      expect(demoteRes.status).toBe(200);
      expect(demoteRes.body.data.member.role).toBe('MEMBER');
    });

    it('protects the last Owner from being demoted or removed', async () => {
      const demoteSelf = await request(app)
        .patch(`/api/v1/organisations/${orgAId}/members/${ownerA.id}/role`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ role: 'ADMIN' });
      expect(demoteSelf.status).toBe(400);
      expect(demoteSelf.body.error.message).toContain('last Owner');

      const removeSelf = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/members/${ownerA.id}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(removeSelf.status).toBe(400);
      expect(removeSelf.body.error.message).toContain('last Owner');
    });

    it('enforces removal RBAC: MEMBER forbidden, ADMIN cannot remove OWNER, ADMIN can remove MEMBER', async () => {
      // MEMBER cannot remove another member
      const memberRemove = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/members/${extraMemberA.id}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(memberRemove.status).toBe(403);

      // ADMIN cannot remove OWNER
      const adminRemoveOwner = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/members/${ownerA.id}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(adminRemoveOwner.status).toBe(403);

      // ADMIN can remove a MEMBER
      const adminRemoveMember = await request(app)
        .delete(`/api/v1/organisations/${orgAId}/members/${extraMemberA.id}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(adminRemoveMember.status).toBe(200);

      // Removed member loses access immediately
      const removedAccess = await request(app)
        .get(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${extraMemberA.accessToken}`);
      expect(removedAccess.status).toBe(404);
    });
  });

  // ─── 5. Strict Cross-Tenant Isolation ─────────────────────────────────────

  describe('Strict Multi-Tenant Isolation (Org A vs Org B)', () => {
    it('creates an invitation in Org B to test cross-org invitation spoofing', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgBId}/invitations`)
        .set('Authorization', `Bearer ${ownerB.accessToken}`)
        .send({ email: `invitee_b_${suffix}@pulsequeue.dev`, role: 'MEMBER' });
      expect(res.status).toBe(201);
      orgBInvitationId = res.body.data.invitation.id;
    });

    it('blocks User A (Owner of Org A) from reading, modifying, or deleting Org B resources', async () => {
      const [
        getOrgB,
        patchOrgB,
        deleteOrgB,
        getMembersB,
        patchMemberRoleB,
        removeMemberB,
        createInviteB,
        listInvitesB,
        revokeInviteBDirect,
        revokeInviteBSpoofedOrg,
        transferOrgB,
      ] = await Promise.all([
        request(app)
          .get(`/api/v1/organisations/${orgBId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .patch(`/api/v1/organisations/${orgBId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ name: 'Cross Tenant Hijack' }),
        request(app)
          .delete(`/api/v1/organisations/${orgBId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/members`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .patch(`/api/v1/organisations/${orgBId}/members/${ownerB.id}/role`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ role: 'MEMBER' }),
        request(app)
          .delete(`/api/v1/organisations/${orgBId}/members/${ownerB.id}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgBId}/invitations`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ email: 'attacker@pulsequeue.dev', role: 'MEMBER' }),
        request(app)
          .get(`/api/v1/organisations/${orgBId}/invitations`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .delete(`/api/v1/organisations/${orgBId}/invitations/${orgBInvitationId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        // Cross-tenant invitation ID passed against Owner A's own valid Org A ID
        request(app)
          .delete(`/api/v1/organisations/${orgAId}/invitations/${orgBInvitationId}`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`),
        request(app)
          .post(`/api/v1/organisations/${orgBId}/transfer-ownership`)
          .set('Authorization', `Bearer ${ownerA.accessToken}`)
          .send({ targetUserId: ownerA.id }),
      ]);

      for (const res of [
        getOrgB,
        patchOrgB,
        deleteOrgB,
        getMembersB,
        patchMemberRoleB,
        removeMemberB,
        createInviteB,
        listInvitesB,
        revokeInviteBDirect,
        revokeInviteBSpoofedOrg,
        transferOrgB,
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
      }

      // Verify Owner A cannot transfer Org A ownership to Owner B (non-member of Org A)
      const crossTransfer = await request(app)
        .post(`/api/v1/organisations/${orgAId}/transfer-ownership`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ targetUserId: ownerB.id });
      expect(crossTransfer.status).toBe(404);
    });
  });

  // ─── 6. Ownership Transfer & Organisation Deletion ────────────────────────

  describe('Ownership Transfer & Organisation Deletion', () => {
    it('forbids ADMIN and MEMBER from deleting organisation or transferring ownership', async () => {
      const adminDelete = await request(app)
        .delete(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(adminDelete.status).toBe(403);

      const memberDelete = await request(app)
        .delete(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${memberA.accessToken}`);
      expect(memberDelete.status).toBe(403);

      const adminTransfer = await request(app)
        .post(`/api/v1/organisations/${orgAId}/transfer-ownership`)
        .set('Authorization', `Bearer ${adminA.accessToken}`)
        .send({ targetUserId: memberA.id });
      expect(adminTransfer.status).toBe(403);
    });

    it('allows OWNER to transfer ownership to an existing member, demoting self to ADMIN', async () => {
      const res = await request(app)
        .post(`/api/v1/organisations/${orgAId}/transfer-ownership`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .send({ targetUserId: adminA.id });

      expect(res.status).toBe(200);
      expect(res.body.data.newOwnerId).toBe(adminA.id);
      expect(res.body.data.previousOwnerId).toBe(ownerA.id);

      // Previous owner is now ADMIN and can no longer delete the organisation
      const oldOwnerDelete = await request(app)
        .delete(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${ownerA.accessToken}`);
      expect(oldOwnerDelete.status).toBe(403);
    });

    it('allows the new OWNER to delete the organisation and cascades memberships/invitations', async () => {
      const deleteRes = await request(app)
        .delete(`/api/v1/organisations/${orgAId}`)
        .set('Authorization', `Bearer ${adminA.accessToken}`);
      expect(deleteRes.status).toBe(200);

      // Verify organisation, memberships, and invitations are gone
      const [org, memberships, invitations] = await Promise.all([
        prisma.organisation.findUnique({ where: { id: orgAId } }),
        prisma.membership.findMany({ where: { organisationId: orgAId } }),
        prisma.invitation.findMany({ where: { organisationId: orgAId } }),
      ]);

      expect(org).toBeNull();
      expect(memberships).toHaveLength(0);
      expect(invitations).toHaveLength(0);
    });
  });
});

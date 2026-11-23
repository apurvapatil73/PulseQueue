import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../config/queryClient';
import { AuthProvider } from '../contexts/AuthContext';
import { OrganisationProvider } from '../contexts/OrganisationContext';
import { AppRoutes } from '../App';
import { authApi } from '../api/auth.api';
import { organisationApi } from '../api/organisation.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import type { InvitationView, MemberView, OrganisationView, OrgRole } from '../types/api';

function renderSettingsApp(initialEntries: string[] = ['/settings'], qc = createQueryClient()) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={initialEntries}>
          <AuthProvider>
            <OrganisationProvider>
              <AppRoutes />
            </OrganisationProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('Organisation Settings & Team Management UI — Profile, Members, Invitations, Ownership Transfer & RBAC (Step 6.4.4)', () => {
  const ownerMember: MemberView = {
    id: 'mem-owner-1',
    role: 'OWNER',
    createdAt: '2026-11-01T00:00:00.000Z',
    user: {
      id: 'user-owner-uuid',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
  };

  const adminMember: MemberView = {
    id: 'mem-admin-2',
    role: 'ADMIN',
    createdAt: '2026-11-05T00:00:00.000Z',
    user: {
      id: 'user-admin-uuid',
      name: 'Rohan Admin',
      email: 'rohan@pulsequeue.dev',
    },
  };

  const regularMember: MemberView = {
    id: 'mem-regular-3',
    role: 'MEMBER',
    createdAt: '2026-11-10T00:00:00.000Z',
    user: {
      id: 'user-member-uuid',
      name: 'Priya Member',
      email: 'priya@pulsequeue.dev',
    },
  };

  const pendingInvite: InvitationView = {
    id: 'inv-pending-1',
    organisationId: 'org-alpha',
    invitedEmail: 'pending@pulsequeue.dev',
    role: 'MEMBER',
    status: 'PENDING',
    expiresAt: '2026-11-30T00:00:00.000Z',
    createdAt: '2026-11-23T00:00:00.000Z',
    invitedBy: {
      id: 'user-owner-uuid',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
  };

  const acceptedInvite: InvitationView = {
    id: 'inv-accepted-2',
    organisationId: 'org-alpha',
    invitedEmail: 'priya@pulsequeue.dev',
    role: 'MEMBER',
    status: 'ACCEPTED',
    expiresAt: '2026-11-17T00:00:00.000Z',
    createdAt: '2026-11-10T00:00:00.000Z',
    invitedBy: {
      id: 'user-owner-uuid',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
  };

  const expiredInvite: InvitationView = {
    id: 'inv-expired-3',
    organisationId: 'org-alpha',
    invitedEmail: 'expired@pulsequeue.dev',
    role: 'ADMIN',
    status: 'EXPIRED',
    expiresAt: '2026-11-08T00:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    invitedBy: {
      id: 'user-owner-uuid',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
  };

  const revokedInvite: InvitationView = {
    id: 'inv-revoked-4',
    organisationId: 'org-alpha',
    invitedEmail: 'revoked@pulsequeue.dev',
    role: 'MEMBER',
    status: 'REVOKED',
    expiresAt: '2026-11-15T00:00:00.000Z',
    createdAt: '2026-11-08T00:00:00.000Z',
    invitedBy: {
      id: 'user-owner-uuid',
      name: 'Apurva Owner',
      email: 'owner@pulsequeue.dev',
    },
  };

  function setupMocks(role: OrgRole = 'OWNER') {
    const currentUser =
      role === 'OWNER'
        ? ownerMember.user
        : role === 'ADMIN'
          ? adminMember.user
          : regularMember.user;

    vi.spyOn(authApi, 'restoreSession').mockResolvedValue({
      ...currentUser,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    vi.spyOn(healthApi, 'getHealth').mockResolvedValue({
      status: 'ok',
      services: { database: 'connected', redis: 'connected' },
      timestamp: new Date().toISOString(),
    });

    const orgAlpha: OrganisationView = {
      id: 'org-alpha',
      name: 'Acme Production',
      role,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };

    const orgBeta: OrganisationView = {
      id: 'org-beta',
      name: 'Beta Analytics',
      role: 'MEMBER',
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };

    vi.spyOn(organisationApi, 'list').mockResolvedValue([orgAlpha, orgBeta]);
    vi.spyOn(organisationApi, 'getById').mockResolvedValue(orgAlpha);
    vi.spyOn(organisationApi, 'listMembers').mockResolvedValue([
      ownerMember,
      adminMember,
      regularMember,
    ]);
    vi.spyOn(organisationApi, 'listInvitations').mockResolvedValue([
      pendingInvite,
      acceptedInvite,
      expiredInvite,
      revokedInvite,
    ]);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    setupMocks('OWNER');
  });

  it('renders organisation profile details, validates name edits, updates organisation name, and invalidates queries', async () => {
    const user = userEvent.setup();
    const qc = createQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const updateSpy = vi
      .spyOn(organisationApi, 'update')
      .mockRejectedValueOnce(
        new ApiClientError('Organisation name cannot be empty', 400, 'BAD_REQUEST'),
      )
      .mockResolvedValueOnce({
        id: 'org-alpha',
        name: 'Acme Global Cloud',
        role: 'OWNER',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-23T08:00:00.000Z',
      });

    renderSettingsApp(['/settings'], qc);

    const nameInput = await screen.findByLabelText('Organisation Name');
    expect(nameInput).toHaveValue('Acme Production');
    expect(screen.getByText('org-alpha')).toBeInTheDocument();

    // Client-side validation rejects 1-char name
    await user.clear(nameInput);
    await user.type(nameInput, 'A');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(
      await screen.findByText(/Organisation name must be at least 2 characters/i),
    ).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();

    // Update to valid name -> first attempt shows backend error, second succeeds
    await user.clear(nameInput);
    await user.paste('Acme Global Cloud');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Organisation name cannot be empty')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => {
      expect(updateSpy).toHaveBeenLastCalledWith('org-alpha', 'Acme Global Cloud');
    });
    expect(
      await screen.findByText(/Organisation renamed to "Acme Global Cloud"/i),
    ).toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisations'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisation', 'org-alpha'] });
  });

  it('lists members, highlights current user, updates member roles (using member.user.id), and removes members with confirmation', async () => {
    const user = userEvent.setup();
    const roleSpy = vi.spyOn(organisationApi, 'updateMemberRole').mockResolvedValue({
      ...regularMember,
      role: 'ADMIN',
    });
    const removeSpy = vi.spyOn(organisationApi, 'removeMember').mockResolvedValue(undefined);

    renderSettingsApp(['/settings']);

    expect(await screen.findByText('Rohan Admin')).toBeInTheDocument();
    expect(screen.getByText('Priya Member')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();

    // Change Priya Member role from MEMBER -> ADMIN (must use member.user.id = 'user-member-uuid')
    const priyaRoleSelect = screen.getByLabelText('Change role for Priya Member');
    await user.selectOptions(priyaRoleSelect, 'ADMIN');

    await waitFor(() => {
      expect(roleSpy).toHaveBeenCalledWith('org-alpha', 'user-member-uuid', 'ADMIN');
    });
    expect(
      await screen.findByText(/Updated Priya Member \(priya@pulsequeue\.dev\) role to ADMIN/i),
    ).toBeInTheDocument();

    // Last OWNER cannot remove themselves
    expect(
      screen.queryByRole('button', { name: /Leave organisation \(Apurva Owner\)/i }),
    ).not.toBeInTheDocument();

    // Remove Priya Member with confirmation dialog (must pass member.user.id = 'user-member-uuid')
    await user.click(screen.getByRole('button', { name: 'Remove member Priya Member' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Member' }));

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('org-alpha', 'user-member-uuid');
    });
    expect(
      await screen.findByText(/Member "Priya Member" removed from the organisation/i),
    ).toBeInTheDocument();
  });

  it('creates invitations, renders PENDING/ACCEPTED/EXPIRED/REVOKED statuses, revokes pending invitations, and handles duplicate 409 errors', async () => {
    const user = userEvent.setup();
    const createInviteSpy = vi
      .spyOn(organisationApi, 'createInvitation')
      .mockRejectedValueOnce(
        new ApiClientError(
          'A pending invitation already exists for this email address',
          409,
          'CONFLICT',
        ),
      )
      .mockResolvedValueOnce({
        invitation: {
          id: 'inv-new-55',
          organisationId: 'org-alpha',
          invitedEmail: 'devops@pulsequeue.dev',
          role: 'ADMIN',
          status: 'PENDING',
          expiresAt: '2026-11-30T00:00:00.000Z',
          createdAt: '2026-11-23T08:00:00.000Z',
          invitedBy: ownerMember.user,
        },
        token: 'dev-invite-token-xyz-999',
      });

    const revokeSpy = vi.spyOn(organisationApi, 'revokeInvitation').mockResolvedValue(undefined);

    renderSettingsApp(['/settings']);

    // Verify all 4 invitation statuses render
    expect(await screen.findByText('pending@pulsequeue.dev')).toBeInTheDocument();
    expect(screen.getByText('expired@pulsequeue.dev')).toBeInTheDocument();
    expect(screen.getByText('revoked@pulsequeue.dev')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('ACCEPTED')).toBeInTheDocument();
    expect(screen.getByText('EXPIRED')).toBeInTheDocument();
    expect(screen.getByText('REVOKED')).toBeInTheDocument();

    // Revoke button only exists on PENDING invitation
    expect(
      screen.getByRole('button', { name: 'Revoke invitation for pending@pulsequeue.dev' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke invitation for expired@pulsequeue.dev' }),
    ).not.toBeInTheDocument();

    // Send invitation as OWNER with ADMIN role -> first call 409 Conflict, second succeeds
    const emailInput = screen.getByLabelText('Invite by Email Address');
    await user.type(emailInput, 'devops@pulsequeue.dev');
    await user.selectOptions(screen.getByLabelText(/Invitation Role/i), 'ADMIN');
    await user.click(screen.getByRole('button', { name: /Send Invite/i }));

    expect(
      await screen.findByText('A pending invitation already exists for this email address'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Send Invite/i }));
    await waitFor(() => {
      expect(createInviteSpy).toHaveBeenLastCalledWith('org-alpha', {
        email: 'devops@pulsequeue.dev',
        role: 'ADMIN',
      });
    });

    expect(
      await screen.findByText(/Invitation sent to devops@pulsequeue\.dev with role ADMIN/i),
    ).toBeInTheDocument();
    expect(screen.getByText('dev-invite-token-xyz-999')).toBeInTheDocument();

    // Revoke pending invitation with confirmation
    await user.click(
      screen.getByRole('button', { name: 'Revoke invitation for pending@pulsequeue.dev' }),
    );
    const revokeDialog = await screen.findByRole('dialog');
    await user.click(within(revokeDialog).getByRole('button', { name: 'Revoke Invitation' }));

    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledWith('org-alpha', pendingInvite.id);
    });
    expect(
      await screen.findByText(/Pending invitation for pending@pulsequeue\.dev revoked/i),
    ).toBeInTheDocument();
  });

  it('accepts a valid invitation token, handles expired/revoked/invalid token errors, and refreshes organisation context', async () => {
    const user = userEvent.setup();
    const qc = createQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const acceptSpy = vi
      .spyOn(organisationApi, 'acceptInvitation')
      .mockRejectedValueOnce(new ApiClientError('Invitation has expired', 400, 'BAD_REQUEST'))
      .mockResolvedValueOnce({
        organisationId: 'org-beta',
        role: 'MEMBER',
        membershipId: 'mem-beta-new',
      });

    renderSettingsApp(['/settings'], qc);
    await screen.findByText('Apurva Owner');

    const tokenInput = screen.getByLabelText('Invitation Token');
    await user.type(tokenInput, 'expired-token-111');
    await user.click(screen.getByRole('button', { name: 'Accept Invitation' }));

    expect(await screen.findByText('Invitation has expired')).toBeInTheDocument();

    await user.clear(tokenInput);
    await user.type(tokenInput, 'valid-token-222');
    await user.click(screen.getByRole('button', { name: 'Accept Invitation' }));

    await waitFor(() => {
      expect(acceptSpy).toHaveBeenLastCalledWith('valid-token-222');
    });
    expect(await screen.findByText(/Invitation accepted!/i)).toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisations'] });
  });

  it('transfers organisation ownership with explicit confirmation and refreshes membership & organisation queries', async () => {
    const user = userEvent.setup();
    const qc = createQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const transferSpy = vi
      .spyOn(organisationApi, 'transferOwnership')
      .mockRejectedValueOnce(
        new ApiClientError('Target user is already an Owner', 400, 'BAD_REQUEST'),
      )
      .mockResolvedValueOnce({
        organisationId: 'org-alpha',
        newOwnerId: adminMember.user.id,
        previousOwnerId: ownerMember.user.id,
      });

    renderSettingsApp(['/settings'], qc);
    await screen.findByText('Rohan Admin');

    // Select Rohan Admin (user-admin-uuid) and open confirmation modal
    await user.selectOptions(
      screen.getByLabelText('Select New Organisation Owner'),
      adminMember.user.id,
    );
    await user.click(screen.getByRole('button', { name: /Transfer Ownership…/i }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Ownership and permissions will change immediately/i),
    ).toBeInTheDocument();

    // First attempt surfaces backend error inside modal
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Ownership Transfer' }));
    expect(await within(dialog).findByText('Target user is already an Owner')).toBeInTheDocument();

    // Second attempt succeeds
    await user.click(within(dialog).getByRole('button', { name: 'Confirm Ownership Transfer' }));
    await waitFor(() => {
      expect(transferSpy).toHaveBeenLastCalledWith('org-alpha', 'user-admin-uuid');
    });

    expect(await screen.findByText(/Ownership transferred to Rohan Admin/i)).toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organisations'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['org-members', 'org-alpha'] });
  });

  it('enforces RBAC differences between ADMIN and MEMBER roles', async () => {
    // 1. ADMIN role:
    // - Can edit organisation name
    // - Cannot change member roles (no role dropdowns)
    // - Can remove MEMBER (Priya) and leave (Rohan), but cannot remove OWNER (Apurva)
    // - Can invite MEMBER only (ADMIN option not offered in invite role select)
    // - Cannot see Transfer Organisation Ownership section
    setupMocks('ADMIN');
    const { unmount: unmountAdmin } = renderSettingsApp(['/settings']);
    expect(await screen.findByLabelText('Organisation Name')).not.toBeDisabled();
    await screen.findByText('Priya Member');

    expect(screen.queryByLabelText('Change role for Priya Member')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove member Apurva Owner' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove member Priya Member' })).toBeInTheDocument();

    const inviteRoleSelect = screen.getByLabelText(/Invitation Role/i) as HTMLSelectElement;
    const roleOptionValues = Array.from(inviteRoleSelect.options).map((o) => o.value);
    expect(roleOptionValues).toEqual(['MEMBER']);

    expect(screen.queryByText('Transfer Organisation Ownership')).not.toBeInTheDocument();
    unmountAdmin();

    // 2. MEMBER role:
    // - Read-only organisation name input
    // - No role change dropdowns or member remove buttons
    // - Does NOT call GET /invitations; shows read-only invitations notice
    // - Can still use Accept Invitation card
    setupMocks('MEMBER');
    const listInvSpy = vi.spyOn(organisationApi, 'listInvitations');
    renderSettingsApp(['/settings']);
    expect(await screen.findByLabelText('Organisation Name')).toBeDisabled();
    await screen.findByText('Rohan Admin');

    expect(screen.getByText(/MEMBER · Read-only/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove member Priya Member' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Leave organisation/i })).not.toBeInTheDocument();
    expect(listInvSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Invitation Token')).toBeInTheDocument();
  });
});

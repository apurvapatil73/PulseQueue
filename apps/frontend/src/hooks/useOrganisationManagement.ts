import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { organisationApi } from '../api/organisation.api';
import type { AssignableMemberRole, CreateInvitationPayload, OrgRole } from '../types/api';

export function canManageOrganisationInvitations(role?: OrgRole | null): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function useOrganisationDetail(organisationId: string | null) {
  return useQuery({
    queryKey: ['organisation', organisationId],
    queryFn: () => organisationApi.getById(organisationId!),
    enabled: Boolean(organisationId),
  });
}

export function useOrganisationMembers(organisationId: string | null) {
  return useQuery({
    queryKey: ['org-members', organisationId],
    queryFn: () => organisationApi.listMembers(organisationId!),
    enabled: Boolean(organisationId),
  });
}

/**
 * Queries organisation invitations.
 * CRITICAL RBAC: Backend `GET /api/v1/organisations/:organisationId/invitations`
 * requires `Role.ADMIN` (`ADMIN` or `OWNER`) and returns 403 for `MEMBER`.
 */
export function useOrganisationInvitations(
  organisationId: string | null,
  callerRole?: OrgRole | null,
) {
  const canViewInvitations = canManageOrganisationInvitations(callerRole);
  return useQuery({
    queryKey: ['org-invitations', organisationId],
    queryFn: () => organisationApi.listInvitations(organisationId!),
    enabled: Boolean(organisationId) && canViewInvitations,
  });
}

function invalidateOrganisationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  organisationId: string | null,
  options: {
    organisationsList?: boolean;
    detail?: boolean;
    members?: boolean;
    invitations?: boolean;
  } = {},
) {
  if (options.organisationsList) {
    void queryClient.invalidateQueries({ queryKey: ['organisations'] });
  }
  if (!organisationId) return;
  if (options.detail) {
    void queryClient.invalidateQueries({ queryKey: ['organisation', organisationId] });
  }
  if (options.members) {
    void queryClient.invalidateQueries({ queryKey: ['org-members', organisationId] });
  }
  if (options.invitations) {
    void queryClient.invalidateQueries({ queryKey: ['org-invitations', organisationId] });
  }
}

export function useUpdateOrganisation(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name }: { name: string }) => organisationApi.update(organisationId!, name),
    onSuccess: () => {
      invalidateOrganisationQueries(queryClient, organisationId, {
        organisationsList: true,
        detail: true,
      });
    },
  });
}

export function useDeleteOrganisation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organisationId: string) => organisationApi.delete(organisationId),
    onSuccess: (_data, deletedOrgId) => {
      queryClient.removeQueries({ queryKey: ['organisation', deletedOrgId] });
      queryClient.removeQueries({ queryKey: ['org-members', deletedOrgId] });
      queryClient.removeQueries({ queryKey: ['org-invitations', deletedOrgId] });
      void queryClient.invalidateQueries({ queryKey: ['organisations'] });
    },
  });
}

/**
 * Transfers organisation ownership (`POST /organisations/:organisationId/transfer-ownership`).
 * `targetUserId` MUST be `member.user.id` (not `member.id`).
 */
export function useTransferOwnership(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ targetUserId }: { targetUserId: string }) =>
      organisationApi.transferOwnership(organisationId!, targetUserId),
    onSuccess: () => {
      invalidateOrganisationQueries(queryClient, organisationId, {
        organisationsList: true,
        detail: true,
        members: true,
      });
    },
  });
}

/**
 * Updates a member's role (`PATCH /organisations/:organisationId/members/:userId/role`).
 * - `userId` MUST be `member.user.id` (not `member.id`).
 * - `role` is restricted to `AssignableMemberRole` (`'ADMIN' | 'MEMBER'`); `OWNER` assignment
 *   must go through `useTransferOwnership`.
 */
export function useUpdateMemberRole(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AssignableMemberRole }) =>
      organisationApi.updateMemberRole(organisationId!, userId, role),
    onSuccess: () => {
      invalidateOrganisationQueries(queryClient, organisationId, {
        organisationsList: true,
        detail: true,
        members: true,
      });
    },
  });
}

/**
 * Removes a member (`DELETE /organisations/:organisationId/members/:userId`).
 * `userId` MUST be `member.user.id` (not `member.id`).
 */
export function useRemoveMember(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId }: { userId: string }) =>
      organisationApi.removeMember(organisationId!, userId),
    onSuccess: () => {
      invalidateOrganisationQueries(queryClient, organisationId, {
        organisationsList: true,
        detail: true,
        members: true,
      });
    },
  });
}

export function useCreateInvitation(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateInvitationPayload) =>
      organisationApi.createInvitation(organisationId!, payload),
    onSuccess: () => {
      invalidateOrganisationQueries(queryClient, organisationId, {
        invitations: true,
      });
    },
  });
}

export function useRevokeInvitation(organisationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      organisationApi.revokeInvitation(organisationId!, invitationId),
    onSuccess: () => {
      invalidateOrganisationQueries(queryClient, organisationId, {
        invitations: true,
      });
    },
  });
}

/**
 * Accepts a standalone invitation token (`POST /api/v1/invitations/accept`).
 * Does not require an active organisation ID.
 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ token }: { token: string }) => organisationApi.acceptInvitation(token),
    onSuccess: (membership) => {
      invalidateOrganisationQueries(queryClient, membership.organisationId, {
        organisationsList: true,
        detail: true,
        members: true,
      });
    },
  });
}

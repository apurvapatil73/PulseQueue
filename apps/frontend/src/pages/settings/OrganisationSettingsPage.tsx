import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  MailPlus,
  RefreshCw,
  Shield,
  ShieldAlert,
  UserMinus,
  Users,
  XCircle,
} from 'lucide-react';
import { ApiClientError } from '../../api/error';
import { useAuth } from '../../contexts/AuthContext';
import { useOrganisation } from '../../contexts/OrganisationContext';
import {
  useAcceptInvitation,
  useCreateInvitation,
  useOrganisationDetail,
  useOrganisationInvitations,
  useOrganisationMembers,
  useRemoveMember,
  useRevokeInvitation,
  useTransferOwnership,
  useUpdateMemberRole,
  useUpdateOrganisation,
} from '../../hooks/useOrganisationManagement';
import type { AssignableMemberRole, InvitationView, MemberView, OrgRole } from '../../types/api';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';

const orgProfileSchema = z.object({
  name: z
    .string({ required_error: 'Organisation name is required' })
    .trim()
    .min(2, 'Organisation name must be at least 2 characters')
    .max(100, 'Organisation name must not exceed 100 characters'),
});

type OrgProfileFormValues = z.infer<typeof orgProfileSchema>;

const inviteFormSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .trim()
    .email('Invalid email address')
    .toLowerCase(),
  role: z.enum(['MEMBER', 'ADMIN']),
});

type InviteFormValues = z.infer<typeof inviteFormSchema>;

const acceptInvitationFormSchema = z.object({
  token: z
    .string({ required_error: 'Invitation token is required' })
    .trim()
    .min(1, 'Invitation token is required'),
});

type AcceptInvitationFormValues = z.infer<typeof acceptInvitationFormSchema>;

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Authoritative member removal RBAC check matching `organisationService.removeMember`:
 * - MEMBER cannot remove anyone (route requires Role.ADMIN).
 * - OWNER can remove any MEMBER or ADMIN, and can remove an OWNER only if > 1 OWNER exists.
 * - ADMIN can remove any MEMBER, and can remove themselves, but cannot remove an OWNER or another ADMIN.
 */
export function canRemoveOrganisationMember(params: {
  callerRole: OrgRole;
  callerUserId: string | undefined;
  targetMember: MemberView;
  ownerCount: number;
}): boolean {
  const { callerRole, callerUserId, targetMember, ownerCount } = params;
  if (callerRole === 'MEMBER') return false;

  if (targetMember.role === 'OWNER') {
    if (callerRole !== 'OWNER') return false;
    return ownerCount > 1;
  }

  if (targetMember.role === 'ADMIN') {
    if (callerRole === 'OWNER') return true;
    return Boolean(callerUserId && targetMember.user.id === callerUserId);
  }

  return true;
}

export function OrganisationSettingsPage() {
  const { user } = useAuth();
  const {
    activeOrganisation,
    activeOrganisationId,
    setActiveOrganisationId,
    isLoading: orgContextLoading,
  } = useOrganisation();

  const detailQuery = useOrganisationDetail(activeOrganisationId);
  const resolvedRole: OrgRole = detailQuery.data?.role ?? activeOrganisation?.role ?? 'MEMBER';
  const isOwner = resolvedRole === 'OWNER';
  const isAdminOrOwner = resolvedRole === 'OWNER' || resolvedRole === 'ADMIN';

  const membersQuery = useOrganisationMembers(activeOrganisationId);
  const invitationsQuery = useOrganisationInvitations(activeOrganisationId, resolvedRole);

  const updateOrgMutation = useUpdateOrganisation(activeOrganisationId);
  const updateRoleMutation = useUpdateMemberRole(activeOrganisationId);
  const removeMemberMutation = useRemoveMember(activeOrganisationId);
  const createInviteMutation = useCreateInvitation(activeOrganisationId);
  const revokeInviteMutation = useRevokeInvitation(activeOrganisationId);
  const acceptInviteMutation = useAcceptInvitation();
  const transferOwnershipMutation = useTransferOwnership(activeOrganisationId);

  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [copiedOrgId, setCopiedOrgId] = useState(false);
  const [issuedDevToken, setIssuedDevToken] = useState<{ email: string; token: string } | null>(
    null,
  );
  const [copiedDevToken, setCopiedDevToken] = useState(false);

  const [roleUpdatingUserId, setRoleUpdatingUserId] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<MemberView | null>(null);
  const [revokingInvitation, setRevokingInvitation] = useState<InvitationView | null>(null);

  const [selectedTransferUserId, setSelectedTransferUserId] = useState<string>('');
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const org = detailQuery.data ?? activeOrganisation;
  const members = membersQuery.data ?? [];
  const invitations = invitationsQuery.data ?? [];

  const ownerCount = useMemo(() => members.filter((m) => m.role === 'OWNER').length, [members]);

  const eligibleTransferTargets = useMemo(
    () => members.filter((m) => m.user.id !== user?.id && m.role !== 'OWNER'),
    [members, user?.id],
  );

  useEffect(() => {
    if (eligibleTransferTargets.length === 0) {
      setSelectedTransferUserId('');
      return;
    }
    const stillValid = eligibleTransferTargets.some((m) => m.user.id === selectedTransferUserId);
    if (!stillValid) {
      setSelectedTransferUserId(eligibleTransferTargets[0].user.id);
    }
  }, [eligibleTransferTargets, selectedTransferUserId]);

  // 1. Organisation Profile Form
  const {
    register: registerProfile,
    handleSubmit: handleSubmitProfile,
    reset: resetProfile,
    watch: watchProfile,
    formState: { errors: profileErrors, isSubmitting: isSavingProfile },
  } = useForm<OrgProfileFormValues>({
    resolver: zodResolver(orgProfileSchema),
    defaultValues: { name: org?.name ?? '' },
  });

  useEffect(() => {
    if (org) {
      resetProfile({ name: org.name });
    }
  }, [org, resetProfile]);

  const watchedOrgName = watchProfile('name');
  const isProfileDirty = Boolean(org && watchedOrgName.trim() !== org.name);

  const onSaveProfile = async (values: OrgProfileFormValues) => {
    setFeedback(null);
    try {
      const updated = await updateOrgMutation.mutateAsync({ name: values.name.trim() });
      resetProfile({ name: updated.name });
      setFeedback({
        type: 'success',
        message: `Organisation renamed to "${updated.name}".`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message:
          err instanceof ApiClientError ? err.message : 'Unable to update organisation profile.',
      });
    }
  };

  // 2. Invite Member Form
  const {
    register: registerInvite,
    handleSubmit: handleSubmitInvite,
    reset: resetInvite,
    setValue: setInviteValue,
    watch: watchInvite,
    formState: { errors: inviteErrors, isSubmitting: isSendingInvite },
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { email: '', role: 'MEMBER' },
  });

  const watchedInviteRole = watchInvite('role');

  useEffect(() => {
    if (!isOwner && watchedInviteRole === 'ADMIN') {
      setInviteValue('role', 'MEMBER');
    }
  }, [isOwner, watchedInviteRole, setInviteValue]);

  const onSendInvite = async (values: InviteFormValues) => {
    setFeedback(null);
    setIssuedDevToken(null);
    try {
      const result = await createInviteMutation.mutateAsync({
        email: values.email.trim().toLowerCase(),
        role: isOwner ? values.role : 'MEMBER',
      });
      resetInvite({ email: '', role: 'MEMBER' });
      if (result.token) {
        setIssuedDevToken({
          email: result.invitation.invitedEmail,
          token: result.token,
        });
      }
      setFeedback({
        type: 'success',
        message: `Invitation sent to ${result.invitation.invitedEmail} with role ${result.invitation.role}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Unable to send invitation.',
      });
    }
  };

  // 3. Accept Invitation Form
  const {
    register: registerAccept,
    handleSubmit: handleSubmitAccept,
    reset: resetAccept,
    formState: { errors: acceptErrors, isSubmitting: isAcceptingInvite },
  } = useForm<AcceptInvitationFormValues>({
    resolver: zodResolver(acceptInvitationFormSchema),
    defaultValues: { token: '' },
  });

  const onAcceptInvitation = async (values: AcceptInvitationFormValues) => {
    setFeedback(null);
    try {
      const membership = await acceptInviteMutation.mutateAsync({
        token: values.token.trim(),
      });
      resetAccept({ token: '' });
      setActiveOrganisationId(membership.organisationId);
      setFeedback({
        type: 'success',
        message: `Invitation accepted! You joined organisation ${membership.organisationId.slice(0, 8)} as ${membership.role}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Unable to accept invitation token.',
      });
    }
  };

  // 4. Member Role Change & Removal Handlers
  const handleRoleChange = async (member: MemberView, newRole: AssignableMemberRole) => {
    if (member.role === newRole) return;
    setFeedback(null);
    setRoleUpdatingUserId(member.user.id);
    try {
      const updated = await updateRoleMutation.mutateAsync({
        userId: member.user.id,
        role: newRole,
      });
      setFeedback({
        type: 'success',
        message: `Updated ${updated.user.name} (${updated.user.email}) role to ${updated.role}.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to update member role.',
      });
    } finally {
      setRoleUpdatingUserId(null);
    }
  };

  const handleConfirmRemoveMember = async () => {
    if (!removingMember) return;
    setFeedback(null);
    try {
      const removedName = removingMember.user.name;
      await removeMemberMutation.mutateAsync({ userId: removingMember.user.id });
      setFeedback({
        type: 'success',
        message: `Member "${removedName}" removed from the organisation.`,
      });
      setRemovingMember(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to remove member.',
      });
    }
  };

  // 5. Revoke Invitation Handler
  const handleConfirmRevokeInvitation = async () => {
    if (!revokingInvitation) return;
    setFeedback(null);
    try {
      const email = revokingInvitation.invitedEmail;
      await revokeInviteMutation.mutateAsync(revokingInvitation.id);
      setFeedback({
        type: 'success',
        message: `Pending invitation for ${email} revoked.`,
      });
      setRevokingInvitation(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof ApiClientError ? err.message : 'Failed to revoke invitation.',
      });
    }
  };

  // 6. Ownership Transfer Handler
  const selectedTransferMember = useMemo(
    () => eligibleTransferTargets.find((m) => m.user.id === selectedTransferUserId) ?? null,
    [eligibleTransferTargets, selectedTransferUserId],
  );

  const handleConfirmTransferOwnership = async () => {
    if (!selectedTransferMember) return;
    setTransferError(null);
    setFeedback(null);
    try {
      await transferOwnershipMutation.mutateAsync({
        targetUserId: selectedTransferMember.user.id,
      });
      setTransferModalOpen(false);
      setFeedback({
        type: 'success',
        message: `Ownership transferred to ${selectedTransferMember.user.name} (${selectedTransferMember.user.email}). Your role is now ADMIN.`,
      });
    } catch (err) {
      setTransferError(
        err instanceof ApiClientError ? err.message : 'Failed to transfer organisation ownership.',
      );
    }
  };

  const handleCopyOrgId = async () => {
    if (!org) return;
    try {
      await navigator.clipboard.writeText(org.id);
      setCopiedOrgId(true);
      setTimeout(() => setCopiedOrgId(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const handleCopyDevToken = async () => {
    if (!issuedDevToken) return;
    try {
      await navigator.clipboard.writeText(issuedDevToken.token);
      setCopiedDevToken(true);
      setTimeout(() => setCopiedDevToken(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const handleRefreshAll = () => {
    void detailQuery.refetch();
    void membersQuery.refetch();
    if (isAdminOrOwner) {
      void invitationsQuery.refetch();
    }
  };

  const inviteRoleOptions = useMemo(() => {
    if (isOwner) {
      return [
        { label: 'MEMBER — Submit jobs, inspect queues/schedules/DLQ', value: 'MEMBER' },
        { label: 'ADMIN — Manage queues, schedules, DLQ replay & invitations', value: 'ADMIN' },
      ];
    }
    return [{ label: 'MEMBER — Submit jobs, inspect queues/schedules/DLQ', value: 'MEMBER' }];
  }, [isOwner]);

  const memberColumns: DataTableColumn<MemberView>[] = [
    {
      key: 'user',
      header: 'Member',
      render: (m) => {
        const isCurrentUser = user?.id === m.user.id;
        return (
          <div className="min-w-[180px]">
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-100">{m.user.name}</span>
              {isCurrentUser && (
                <span className="rounded border border-sky-400/30 bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                  You
                </span>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs text-slate-400">{m.user.email}</p>
          </div>
        );
      },
    },
    {
      key: 'role',
      header: 'Role',
      render: (m) => <StatusBadge status={m.role} />,
    },
    {
      key: 'joined',
      header: 'Joined',
      render: (m) => (
        <span className="font-mono text-xs text-slate-400 whitespace-nowrap">
          {formatDateTime(m.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Role & Membership Actions',
      align: 'right',
      render: (m) => {
        const canChangeRole = isOwner && (m.role !== 'OWNER' || ownerCount > 1);
        const canRemove = canRemoveOrganisationMember({
          callerRole: resolvedRole,
          callerUserId: user?.id,
          targetMember: m,
          ownerCount,
        });
        const isCurrentUser = user?.id === m.user.id;
        const isUpdatingThisMember = roleUpdatingUserId === m.user.id;

        if (!canChangeRole && !canRemove) {
          return <span className="text-xs text-slate-500">—</span>;
        }

        return (
          <div className="flex items-center justify-end gap-2">
            {canChangeRole && m.role !== 'OWNER' && (
              <div className="w-32">
                <Select
                  id={`member-role-${m.user.id}`}
                  aria-label={`Change role for ${m.user.name}`}
                  value={m.role}
                  disabled={isUpdatingThisMember}
                  onChange={(e) => void handleRoleChange(m, e.target.value as AssignableMemberRole)}
                  options={[
                    { label: 'MEMBER', value: 'MEMBER' },
                    { label: 'ADMIN', value: 'ADMIN' },
                  ]}
                />
              </div>
            )}

            {canRemove && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={
                  isCurrentUser
                    ? `Leave organisation (${m.user.name})`
                    : `Remove member ${m.user.name}`
                }
                onClick={() => setRemovingMember(m)}
                className="text-rose-300 hover:text-rose-200"
                leftIcon={<UserMinus className="h-3.5 w-3.5" />}
              >
                {isCurrentUser ? 'Leave' : 'Remove'}
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const invitationColumns: DataTableColumn<InvitationView>[] = [
    {
      key: 'email',
      header: 'Invited Email',
      render: (inv) => (
        <span className="font-mono text-xs font-medium text-slate-100">{inv.invitedEmail}</span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (inv) => <StatusBadge status={inv.role} />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (inv) => <StatusBadge status={inv.status} showDot />,
    },
    {
      key: 'invitedBy',
      header: 'Invited By',
      render: (inv) => (
        <span className="text-xs text-slate-300">
          {inv.invitedBy.name}{' '}
          <span className="font-mono text-[11px] text-slate-500">({inv.invitedBy.email})</span>
        </span>
      ),
    },
    {
      key: 'timestamps',
      header: 'Sent / Expires At',
      render: (inv) => (
        <div className="font-mono text-[11px] text-slate-400 whitespace-nowrap">
          <div>Sent: {formatDateTime(inv.createdAt)}</div>
          <div>Expires: {formatDateTime(inv.expiresAt)}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (inv) => {
        if (inv.status !== 'PENDING') {
          return <span className="text-xs text-slate-500">—</span>;
        }
        return (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Revoke invitation for ${inv.invitedEmail}`}
            onClick={() => setRevokingInvitation(inv)}
            className="text-rose-300 hover:text-rose-200"
            leftIcon={<XCircle className="h-3.5 w-3.5" />}
          >
            Revoke
          </Button>
        );
      },
    },
  ];

  const isLoading = orgContextLoading || detailQuery.isLoading;

  return (
    <PageContainer
      title="Organisation Settings"
      description={
        org
          ? `Manage workspace profile, team memberships, role-based access control, invitations, and ownership for ${org.name}`
          : 'Loading organisation settings…'
      }
      actions={
        <>
          {!isAdminOrOwner && (
            <StatusBadge status="MEMBER" label={`${resolvedRole} · Read-only`} tone="slate" />
          )}
          <Button
            variant="secondary"
            size="md"
            leftIcon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  detailQuery.isFetching || membersQuery.isFetching || invitationsQuery.isFetching
                    ? 'animate-spin'
                    : ''
                }`}
              />
            }
            onClick={handleRefreshAll}
          >
            Refresh
          </Button>
        </>
      }
    >
      {feedback && (
        <div className="mb-5">
          {feedback.type === 'error' ? (
            <ErrorState compact message={feedback.message} />
          ) : (
            <div
              role="status"
              className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>{feedback.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-xs text-emerald-300 hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {detailQuery.error && (
        <div className="mb-6">
          <ErrorState
            title="Unable to load organisation details"
            message={
              detailQuery.error instanceof Error
                ? detailQuery.error.message
                : 'Failed to load organisation profile'
            }
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      )}

      {/* Top Row: Organisation Profile & Accept Invitation Token */}
      <section className="grid gap-6 lg:grid-cols-3">
        {/* 1. Organisation Profile Card */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Workspace Profile"
            description="Persisted organisation identity, role permissions, and metadata"
            action={
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Your Role:</span>
                <StatusBadge status={resolvedRole} />
              </div>
            }
          />
          <CardContent>
            {isLoading || !org ? (
              <div className="space-y-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
              </div>
            ) : (
              <div className="space-y-5">
                <form
                  onSubmit={handleSubmitProfile(onSaveProfile)}
                  className="space-y-4"
                  noValidate
                >
                  <Input
                    id="orgProfileName"
                    label="Organisation Name"
                    disabled={!isAdminOrOwner || isSavingProfile}
                    hint={
                      isAdminOrOwner
                        ? '2–100 characters. Visible across the workspace switcher and audit headers.'
                        : 'Only organisation Admins and Owners can rename the workspace.'
                    }
                    error={profileErrors.name?.message}
                    {...registerProfile('name')}
                  />

                  {isAdminOrOwner && (
                    <div className="flex items-center justify-end gap-2.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!isProfileDirty || isSavingProfile}
                        onClick={() => resetProfile({ name: org.name })}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!isProfileDirty}
                        isLoading={isSavingProfile}
                      >
                        Save Changes
                      </Button>
                    </div>
                  )}
                </form>

                <dl className="divide-y divide-border-subtle border-t border-border-subtle pt-3 text-xs">
                  <div className="flex items-center justify-between py-2.5 gap-2">
                    <dt className="text-slate-400">Organisation ID</dt>
                    <dd className="flex items-center gap-2">
                      <span className="font-mono text-slate-200">{org.id}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Copy organisation ID"
                        onClick={() => void handleCopyOrgId()}
                        leftIcon={
                          copiedOrgId ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )
                        }
                      >
                        {copiedOrgId ? 'Copied' : 'Copy'}
                      </Button>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between py-2.5 gap-2">
                    <dt className="text-slate-400">Created At</dt>
                    <dd className="font-mono text-slate-300">{formatDateTime(org.createdAt)}</dd>
                  </div>
                  <div className="flex items-center justify-between py-2.5 gap-2">
                    <dt className="text-slate-400">Last Updated</dt>
                    <dd className="font-mono text-slate-300">{formatDateTime(org.updatedAt)}</dd>
                  </div>
                </dl>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 2. Accept Invitation Token Card */}
        <Card>
          <CardHeader
            title="Accept Invitation"
            description="Join an organisation using an invitation token sent to your account email"
            action={<KeyRound className="h-4 w-4 text-sky-400" />}
          />
          <CardContent>
            <form
              onSubmit={handleSubmitAccept(onAcceptInvitation)}
              className="space-y-4"
              noValidate
            >
              <p className="text-xs text-slate-400">
                Paste a valid invitation token below. The backend verifies that your signed-in email
                (<span className="font-mono text-slate-200">{user?.email ?? '—'}</span>) matches the
                invited email address.
              </p>

              <Input
                id="acceptInvitationToken"
                label="Invitation Token"
                placeholder="Paste invitation token…"
                error={acceptErrors.token?.message}
                {...registerAccept('token')}
              />

              <Button type="submit" size="sm" className="w-full" isLoading={isAcceptingInvite}>
                Accept Invitation
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>

      {/* 3. Team Members Management Section */}
      <section className="mt-6">
        <Card>
          <CardHeader
            title="Team Members"
            description={
              isOwner
                ? 'Manage team roles (ADMIN / MEMBER) and remove members. Ownership requires a dedicated transfer.'
                : isAdminOrOwner
                  ? 'View team memberships and remove MEMBER accounts. Only Owners can change member roles.'
                  : 'Active members in this organisation workspace.'
            }
            action={
              <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-400">
                <Users className="h-3.5 w-3.5 text-sky-400" />
                {members.length} member(s)
              </span>
            }
          />
          {membersQuery.error ? (
            <div className="p-5">
              <ErrorState
                compact
                message={
                  membersQuery.error instanceof Error
                    ? membersQuery.error.message
                    : 'Unable to load organisation members'
                }
                onRetry={() => void membersQuery.refetch()}
              />
            </div>
          ) : (
            <DataTable
              columns={memberColumns}
              data={members}
              rowKey={(m) => m.id}
              isLoading={membersQuery.isLoading}
              skeletonRows={3}
              emptyState={
                <EmptyState
                  icon={<Users className="h-5 w-5" />}
                  title="No members found"
                  description="Organisation members will appear here."
                />
              }
            />
          )}
        </Card>
      </section>

      {/* 4. Team Invitations Section */}
      <section className="mt-6">
        <Card>
          <CardHeader
            title="Team Invitations"
            description={
              isOwner
                ? 'Invite new members as ADMIN or MEMBER and manage pending invitations.'
                : isAdminOrOwner
                  ? 'Admins can invite new users with the MEMBER role and revoke pending invitations.'
                  : 'Invitations are managed by organisation Admins and Owners.'
            }
            action={<MailPlus className="h-4 w-4 text-sky-400" />}
          />

          {!isAdminOrOwner ? (
            <CardContent>
              <div className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-canvas/50 p-4 text-xs text-slate-400">
                <Shield className="h-4 w-4 shrink-0 text-slate-500" />
                <span>
                  You have <span className="font-mono font-semibold text-slate-200">MEMBER</span>{' '}
                  access in this organisation. Only <span className="font-mono">ADMIN</span> and{' '}
                  <span className="font-mono">OWNER</span> roles can view or send organisation
                  invitations.
                </span>
              </div>
            </CardContent>
          ) : (
            <>
              <div className="border-b border-border-subtle p-5 space-y-4">
                <form
                  onSubmit={handleSubmitInvite(onSendInvite)}
                  className="grid gap-3.5 sm:grid-cols-12 sm:items-start"
                  noValidate
                >
                  <div className="sm:col-span-6">
                    <Input
                      id="inviteMemberEmail"
                      label="Invite by Email Address"
                      type="email"
                      placeholder="teammate@company.com"
                      error={inviteErrors.email?.message}
                      {...registerInvite('email')}
                    />
                  </div>
                  <div className="sm:col-span-4">
                    <Select
                      id="inviteMemberRole"
                      label={
                        isOwner
                          ? 'Invitation Role (ADMIN / MEMBER)'
                          : 'Invitation Role (MEMBER only)'
                      }
                      options={inviteRoleOptions}
                      error={inviteErrors.role?.message}
                      value={watchedInviteRole}
                      onChange={(e) =>
                        setInviteValue('role', e.target.value as 'MEMBER' | 'ADMIN', {
                          shouldValidate: true,
                        })
                      }
                    />
                  </div>
                  <div className="sm:col-span-2 sm:pt-6">
                    <Button
                      type="submit"
                      size="md"
                      className="w-full"
                      isLoading={isSendingInvite}
                      leftIcon={<MailPlus className="h-3.5 w-3.5" />}
                    >
                      Send Invite
                    </Button>
                  </div>
                </form>

                {issuedDevToken && (
                  <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3.5 py-2.5 text-xs text-sky-200">
                    <div className="space-y-0.5 min-w-0">
                      <span className="font-semibold text-sky-100">
                        Invitation token for {issuedDevToken.email}:
                      </span>
                      <p className="font-mono text-[11px] break-all text-sky-200">
                        {issuedDevToken.token}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleCopyDevToken()}
                      leftIcon={
                        copiedDevToken ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )
                      }
                    >
                      {copiedDevToken ? 'Copied' : 'Copy Token'}
                    </Button>
                  </div>
                )}
              </div>

              {invitationsQuery.error ? (
                <div className="p-5">
                  <ErrorState
                    compact
                    message={
                      invitationsQuery.error instanceof Error
                        ? invitationsQuery.error.message
                        : 'Unable to load invitations'
                    }
                    onRetry={() => void invitationsQuery.refetch()}
                  />
                </div>
              ) : (
                <DataTable
                  columns={invitationColumns}
                  data={invitations}
                  rowKey={(inv) => inv.id}
                  isLoading={invitationsQuery.isLoading}
                  skeletonRows={3}
                  emptyState={
                    <EmptyState
                      icon={<Building2 className="h-5 w-5" />}
                      title="No invitations sent yet"
                      description="Invite teammates by email above to grant them MEMBER or ADMIN access."
                    />
                  }
                />
              )}
            </>
          )}
        </Card>
      </section>

      {/* 5. Ownership Transfer Section (OWNER only) */}
      {isOwner && (
        <section className="mt-6">
          <Card className="border-amber-500/30">
            <CardHeader
              title="Transfer Organisation Ownership"
              description="Promote an existing member to OWNER and demote your current membership to ADMIN"
              action={<ShieldAlert className="h-4 w-4 text-amber-400" />}
            />
            <CardContent>
              {eligibleTransferTargets.length === 0 ? (
                <p className="text-xs text-slate-400">
                  No eligible members available for ownership transfer. Invite and onboard another
                  team member before transferring ownership.
                </p>
              ) : (
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="flex-1 max-w-md">
                    <Select
                      id="transferOwnershipTarget"
                      label="Select New Organisation Owner"
                      value={selectedTransferUserId}
                      onChange={(e) => setSelectedTransferUserId(e.target.value)}
                      options={eligibleTransferTargets.map((m) => ({
                        label: `${m.user.name} (${m.user.email}) — Current: ${m.role}`,
                        value: m.user.id,
                      }))}
                    />
                  </div>
                  <Button
                    variant="danger"
                    size="md"
                    disabled={!selectedTransferMember}
                    onClick={() => {
                      setTransferError(null);
                      setTransferModalOpen(true);
                    }}
                  >
                    Transfer Ownership…
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {/* Remove Member Confirmation Dialog */}
      <ConfirmDialog
        isOpen={Boolean(removingMember)}
        onClose={() => setRemovingMember(null)}
        onConfirm={handleConfirmRemoveMember}
        title={
          removingMember && removingMember.user.id === user?.id
            ? `Leave Organisation "${org?.name ?? ''}"?`
            : `Remove Member "${removingMember?.user.name ?? ''}"?`
        }
        description={
          removingMember && removingMember.user.id === user?.id
            ? 'You will immediately lose access to this organisation’s queues, jobs, schedules, and DLQ records.'
            : `Removing ${removingMember?.user.name ?? ''} (${removingMember?.user.email ?? ''}) revokes their access to this organisation immediately.`
        }
        confirmLabel={
          removingMember && removingMember.user.id === user?.id
            ? 'Leave Organisation'
            : 'Remove Member'
        }
        destructive
        isLoading={removeMemberMutation.isPending}
      />

      {/* Revoke Invitation Confirmation Dialog */}
      <ConfirmDialog
        isOpen={Boolean(revokingInvitation)}
        onClose={() => setRevokingInvitation(null)}
        onConfirm={handleConfirmRevokeInvitation}
        title="Revoke Pending Invitation?"
        description={`Revoking the invitation for ${revokingInvitation?.invitedEmail ?? ''} invalidates its token immediately so it can no longer be accepted.`}
        confirmLabel="Revoke Invitation"
        destructive
        isLoading={revokeInviteMutation.isPending}
      />

      {/* Ownership Transfer Confirmation Modal */}
      <Modal
        isOpen={transferModalOpen}
        onClose={() => setTransferModalOpen(false)}
        title="Confirm Ownership Transfer"
        description={`Transfer ownership of "${org?.name ?? ''}" to ${selectedTransferMember?.user.name ?? ''}.`}
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="space-y-1">
                <p className="font-semibold text-amber-100">
                  Ownership and permissions will change immediately
                </p>
                <p className="text-amber-200/85">
                  <span className="font-semibold">{selectedTransferMember?.user.name}</span> (
                  <span className="font-mono">{selectedTransferMember?.user.email}</span>) will be
                  promoted to <span className="font-mono font-semibold">OWNER</span>, and your
                  membership will be downgraded to{' '}
                  <span className="font-mono font-semibold">ADMIN</span>. You will no longer be able
                  to delete queues/schedules, change member roles, or transfer ownership unless the
                  new owner transfers it back.
                </p>
              </div>
            </div>
          </div>

          {transferError && <ErrorState compact message={transferError} />}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTransferModalOpen(false)}
              disabled={transferOwnershipMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              isLoading={transferOwnershipMutation.isPending}
              onClick={() => void handleConfirmTransferOwnership()}
            >
              Confirm Ownership Transfer
            </Button>
          </div>
        </div>
      </Modal>
    </PageContainer>
  );
}

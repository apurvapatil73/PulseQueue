import type {
  AcceptInvitationResult,
  ApiEnvelope,
  AssignableMemberRole,
  CreateInvitationPayload,
  CreateInvitationResult,
  InvitationView,
  MemberView,
  OrganisationView,
  TransferOwnershipResult,
} from '../types/api';
import { apiClient, unwrapApiData } from './apiClient';

export const organisationApi = {
  async list(): Promise<OrganisationView[]> {
    const { data } =
      await apiClient.get<ApiEnvelope<{ organisations: OrganisationView[] }>>(
        '/api/v1/organisations',
      );
    return unwrapApiData(data).organisations;
  },

  async create(name: string): Promise<OrganisationView> {
    const { data } = await apiClient.post<ApiEnvelope<{ organisation: OrganisationView }>>(
      '/api/v1/organisations',
      { name },
    );
    return unwrapApiData(data).organisation;
  },

  async getById(organisationId: string): Promise<OrganisationView> {
    const { data } = await apiClient.get<ApiEnvelope<{ organisation: OrganisationView }>>(
      `/api/v1/organisations/${organisationId}`,
    );
    return unwrapApiData(data).organisation;
  },

  async update(organisationId: string, name: string): Promise<OrganisationView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ organisation: OrganisationView }>>(
      `/api/v1/organisations/${organisationId}`,
      { name },
    );
    return unwrapApiData(data).organisation;
  },

  async delete(organisationId: string): Promise<void> {
    await apiClient.delete(`/api/v1/organisations/${organisationId}`);
  },

  async transferOwnership(
    organisationId: string,
    targetUserId: string,
  ): Promise<TransferOwnershipResult> {
    const { data } = await apiClient.post<ApiEnvelope<TransferOwnershipResult>>(
      `/api/v1/organisations/${organisationId}/transfer-ownership`,
      { targetUserId },
    );
    return unwrapApiData(data);
  },

  async listMembers(organisationId: string): Promise<MemberView[]> {
    const { data } = await apiClient.get<ApiEnvelope<{ members: MemberView[] }>>(
      `/api/v1/organisations/${organisationId}/members`,
    );
    return unwrapApiData(data).members;
  },

  async updateMemberRole(
    organisationId: string,
    userId: string,
    role: AssignableMemberRole,
  ): Promise<MemberView> {
    const { data } = await apiClient.patch<ApiEnvelope<{ member: MemberView }>>(
      `/api/v1/organisations/${organisationId}/members/${userId}/role`,
      { role },
    );
    return unwrapApiData(data).member;
  },

  async removeMember(organisationId: string, userId: string): Promise<void> {
    await apiClient.delete(`/api/v1/organisations/${organisationId}/members/${userId}`);
  },

  async listInvitations(organisationId: string): Promise<InvitationView[]> {
    const { data } = await apiClient.get<ApiEnvelope<{ invitations: InvitationView[] }>>(
      `/api/v1/organisations/${organisationId}/invitations`,
    );
    return unwrapApiData(data).invitations;
  },

  async createInvitation(
    organisationId: string,
    payload: CreateInvitationPayload,
  ): Promise<CreateInvitationResult> {
    const { data } = await apiClient.post<ApiEnvelope<CreateInvitationResult>>(
      `/api/v1/organisations/${organisationId}/invitations`,
      payload,
    );
    return unwrapApiData(data);
  },

  async revokeInvitation(organisationId: string, invitationId: string): Promise<void> {
    await apiClient.delete(`/api/v1/organisations/${organisationId}/invitations/${invitationId}`);
  },

  async acceptInvitation(token: string): Promise<AcceptInvitationResult> {
    const { data } = await apiClient.post<ApiEnvelope<{ membership: AcceptInvitationResult }>>(
      '/api/v1/invitations/accept',
      { token },
    );
    return unwrapApiData(data).membership;
  },
};

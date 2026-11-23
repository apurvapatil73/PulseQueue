import type { ApiEnvelope, OrganisationView } from '../types/api';
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
};

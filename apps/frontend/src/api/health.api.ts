import type { HealthReport } from '../types/api';
import { apiClient } from './apiClient';

export const healthApi = {
  async getHealth(): Promise<HealthReport> {
    const { data } = await apiClient.get<HealthReport>('/health');
    return data;
  },
};

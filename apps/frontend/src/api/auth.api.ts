import type { ApiEnvelope, SafeUser } from '../types/api';
import { apiClient, performSilentRefresh, unwrapApiData } from './apiClient';
import { clearAccessToken, setAccessToken } from './tokenStore';

export interface LoginPayload {
  email: string;
  password: string;
}

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
}

interface LoginResponseData {
  user: SafeUser;
  accessToken: string;
}

export const authApi = {
  async login(payload: LoginPayload): Promise<SafeUser> {
    const { data } = await apiClient.post<ApiEnvelope<LoginResponseData>>(
      '/api/v1/auth/login',
      payload,
    );
    const result = unwrapApiData(data);
    // Store only short-lived accessToken in memory; refresh token is stored by browser in HttpOnly cookie
    setAccessToken(result.accessToken);
    return result.user;
  },

  async register(payload: RegisterPayload): Promise<SafeUser> {
    const { data } = await apiClient.post<ApiEnvelope<{ user: SafeUser }>>(
      '/api/v1/auth/register',
      payload,
    );
    return unwrapApiData(data).user;
  },

  async getMe(): Promise<SafeUser> {
    const { data } = await apiClient.get<ApiEnvelope<{ user: SafeUser }>>('/api/v1/auth/me');
    return unwrapApiData(data).user;
  },

  async restoreSession(): Promise<SafeUser | null> {
    const token = await performSilentRefresh();
    if (!token) {
      return null;
    }
    try {
      return await authApi.getMe();
    } catch {
      clearAccessToken();
      return null;
    }
  },

  async logout(): Promise<void> {
    try {
      await apiClient.post('/api/v1/auth/logout', {});
    } finally {
      clearAccessToken();
    }
  },
};

import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { frontendEnv } from '../config/env';
import type { ApiEnvelope } from '../types/api';
import { normalizeApiError } from './error';
import {
  clearAccessToken,
  getAccessToken,
  notifySessionExpired,
  setAccessToken,
} from './tokenStore';

interface RetryableRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

const AUTH_NO_RETRY_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
];

export const apiClient = axios.create({
  baseURL: frontendEnv.apiBaseUrl,
  withCredentials: true,
  timeout: 15_000,
  headers: {
    'Content-Type': 'application/json',
  },
});

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Performs a single-flight deduplicated refresh call using the HttpOnly refresh cookie.
 * Prevents concurrent 401 responses from replaying the same single-use refresh token.
 */
export async function performSilentRefresh(): Promise<string | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const response = await axios.post<ApiEnvelope<{ accessToken: string }>>(
        `${frontendEnv.apiBaseUrl}/api/v1/auth/refresh`,
        {},
        {
          withCredentials: true,
          timeout: 10_000,
          headers: { 'Content-Type': 'application/json' },
        },
      );

      const newToken = response.data?.data?.accessToken ?? null;
      setAccessToken(newToken);
      return newToken;
    } catch {
      clearAccessToken();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

apiClient.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryableRequestConfig | undefined;
    const status = error.response?.status;
    const requestUrl = originalRequest?.url ?? '';

    const isAuthEndpoint = AUTH_NO_RETRY_PATHS.some((path) => requestUrl.includes(path));

    if (status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;
      const newToken = await performSilentRefresh();

      if (newToken) {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      }

      notifySessionExpired();
    }

    return Promise.reject(normalizeApiError(error));
  },
);

export function unwrapApiData<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.success || envelope.data === undefined) {
    throw new Error(envelope.error?.message ?? 'Unexpected empty API response');
  }
  return envelope.data;
}

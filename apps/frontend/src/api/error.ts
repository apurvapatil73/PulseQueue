import axios from 'axios';
import type { ApiEnvelope } from '../types/api';

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly fieldErrors?: Record<string, string[] | undefined>;

  constructor(
    message: string,
    status: number,
    code: string = 'API_ERROR',
    fieldErrors?: Record<string, string[] | undefined>,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function normalizeApiError(err: unknown): ApiClientError {
  if (err instanceof ApiClientError) {
    return err;
  }

  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 0;
    const payload = err.response?.data as ApiEnvelope<unknown> | undefined;

    if (payload?.error) {
      return new ApiClientError(
        payload.error.message || 'Request failed',
        status,
        payload.error.code || 'API_ERROR',
        payload.error.details,
      );
    }

    if (err.code === 'ECONNABORTED') {
      return new ApiClientError('Request timed out. Please try again.', 408, 'TIMEOUT');
    }

    if (!err.response) {
      return new ApiClientError(
        'Unable to reach the PulseQueue API server. Verify the backend is running.',
        0,
        'NETWORK_ERROR',
      );
    }

    return new ApiClientError(
      err.message || `Request failed with status ${status}`,
      status,
      'HTTP_ERROR',
    );
  }

  if (err instanceof Error) {
    return new ApiClientError(err.message, 0, 'UNEXPECTED_ERROR');
  }

  return new ApiClientError('An unexpected error occurred', 0, 'UNKNOWN_ERROR');
}

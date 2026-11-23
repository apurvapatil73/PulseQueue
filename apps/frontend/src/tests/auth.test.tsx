import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../config/queryClient';
import { AuthProvider } from '../contexts/AuthContext';
import { OrganisationProvider } from '../contexts/OrganisationContext';
import { AppRoutes } from '../App';
import { authApi } from '../api/auth.api';
import { organisationApi } from '../api/organisation.api';
import { monitoringApi } from '../api/monitoring.api';
import { scheduleApi } from '../api/schedule.api';
import { healthApi } from '../api/health.api';
import { ApiClientError } from '../api/error';
import {
  clearAccessToken,
  getAccessToken,
  notifySessionExpired,
  onSessionExpired,
  setAccessToken,
} from '../api/tokenStore';

function renderApp(initialEntries: string[] = ['/dashboard']) {
  const qc = createQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <OrganisationProvider>
            <AppRoutes />
          </OrganisationProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Frontend Authentication, Protected Routes & Session Security', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearAccessToken();
    window.localStorage.clear();
    window.sessionStorage.clear();

    vi.spyOn(healthApi, 'getHealth').mockResolvedValue({
      status: 'ok',
      services: { database: 'connected', redis: 'connected' },
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(organisationApi, 'list').mockResolvedValue([]);
    vi.spyOn(monitoringApi, 'getMetrics').mockResolvedValue({
      organisationId: 'org-1',
      summary: {
        totalSubmitted: 0,
        totalProcessed: 0,
        succeeded: 0,
        failed: 0,
        active: 0,
        pending: 0,
        delayed: 0,
        paused: 0,
        retriedJobs: 0,
        totalRetryEvents: 0,
        stalledRecoveries: 0,
        deadLetterOpen: 0,
        deadLetterReplayed: 0,
        averageDurationMs: null,
      },
      throughput: {
        windowMinutes: 60,
        completedInWindow: 0,
        failedInWindow: 0,
        processedInWindow: 0,
        jobsPerMinute: 0,
      },
      queues: [],
      workers: [],
      generatedAt: new Date().toISOString(),
    });
    vi.spyOn(monitoringApi, 'listEvents').mockResolvedValue({
      events: [],
      pagination: {
        page: 1,
        limit: 8,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
    vi.spyOn(scheduleApi, 'list').mockResolvedValue({
      schedules: [],
      pagination: {
        page: 1,
        limit: 5,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  });

  it('redirects unauthenticated users from protected /dashboard to /login', async () => {
    vi.spyOn(authApi, 'restoreSession').mockResolvedValue(null);

    renderApp(['/dashboard']);

    expect(await screen.findByText('Sign in to PulseQueue')).toBeInTheDocument();
  });

  it('validates login inputs and renders safe API error banner on invalid credentials', async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, 'restoreSession').mockResolvedValue(null);
    const loginSpy = vi
      .spyOn(authApi, 'login')
      .mockRejectedValue(new ApiClientError('Invalid email or password', 401, 'UNAUTHORIZED'));

    renderApp(['/login']);
    await screen.findByText('Sign in to PulseQueue');

    // Submit empty form -> Zod validation blocks API call
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(loginSpy).not.toHaveBeenCalled();

    // Fill valid format but wrong credentials -> backend error shown cleanly
    await user.type(screen.getByLabelText('Work Email'), 'dev@pulsequeue.io');
    await user.type(screen.getByLabelText('Password'), 'WrongPass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
  });

  it('signs in cleanly without writing tokens to localStorage and signs out via account menu', async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, 'restoreSession').mockResolvedValue(null);
    vi.spyOn(authApi, 'login').mockResolvedValue({
      id: 'user-1',
      name: 'Maya Patel',
      email: 'maya@pulsequeue.dev',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const logoutSpy = vi.spyOn(authApi, 'logout').mockResolvedValue();

    renderApp(['/login']);
    await screen.findByText('Sign in to PulseQueue');

    await user.type(screen.getByLabelText('Work Email'), 'maya@pulsequeue.dev');
    await user.type(screen.getByLabelText('Password'), 'StrongPass123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Welcome to PulseQueue')).toBeInTheDocument();

    // Security invariant: never store refresh or access tokens in localStorage
    expect(window.localStorage.length).toBe(0);

    // Open user menu and sign out
    await user.click(screen.getByRole('button', { name: /Maya Patel/i }));
    await user.click(screen.getByRole('menuitem', { name: /Sign out/i }));

    await waitFor(() => {
      expect(logoutSpy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('Sign in to PulseQueue')).toBeInTheDocument();
  });

  it('manages access token strictly in memory and notifies listeners on session expiry', () => {
    const listener = vi.fn();
    const unsub = onSessionExpired(listener);

    setAccessToken('ephemeral-jwt-token');
    expect(getAccessToken()).toBe('ephemeral-jwt-token');
    expect(window.localStorage.length).toBe(0);

    notifySessionExpired();
    expect(getAccessToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
  });
});

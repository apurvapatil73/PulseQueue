import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Activity, AlertOctagon, CalendarClock, Layers, ListChecks, Settings } from 'lucide-react';
import { queryClient } from './config/queryClient';
import { AuthProvider } from './contexts/AuthContext';
import { OrganisationProvider } from './contexts/OrganisationContext';
import { AppShell } from './components/layout/AppShell';
import { ProtectedRoute } from './components/routing/ProtectedRoute';
import { PublicOnlyRoute } from './components/routing/PublicOnlyRoute';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';
import { DashboardOverviewPage } from './pages/dashboard/DashboardOverviewPage';
import { ModulePlaceholderPage } from './pages/modules/ModulePlaceholderPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardOverviewPage />} />
          <Route
            path="/queues"
            element={
              <ModulePlaceholderPage
                title="Queues"
                description="Manage organisation-scoped queues, concurrency, retry policies, and pause/resume controls."
                icon={<Layers className="h-5 w-5" />}
                milestoneLabel="Step 6.2 Planned"
                plannedCapabilities={[
                  'Create, edit, pause, resume, and delete organisation queues',
                  'Configure concurrency, default priority, max retries, and exponential backoff',
                  'Inspect per-queue depth, latency, and BullMQ sync health',
                ]}
              />
            }
          />
          <Route
            path="/jobs"
            element={
              <ModulePlaceholderPage
                title="Jobs"
                description="Submit, filter, inspect, and cancel organisation jobs across queues."
                icon={<ListChecks className="h-5 w-5" />}
                milestoneLabel="Step 6.2 Planned"
                plannedCapabilities={[
                  'Submit jobs with validated JSON payloads, priorities, delays, and retry overrides',
                  'Filter jobs by queue, status, and timestamps with cursor/page navigation',
                  'Inspect execution results, errors, attempts, and cancel pending/delayed jobs',
                ]}
              />
            }
          />
          <Route
            path="/schedules"
            element={
              <ModulePlaceholderPage
                title="Schedules"
                description="Orchestrate one-time and recurring cron schedules with timezone, DST, and misfire controls."
                icon={<CalendarClock className="h-5 w-5" />}
                milestoneLabel="Step 6.3 Planned"
                plannedCapabilities={[
                  'Create one-time and IANA timezone-aware cron schedules with next-run previews',
                  'Configure SKIP_MISSED, FIRE_ONCE, and CATCH_UP misfire policies and concurrency caps',
                  'Inspect immutable ScheduleExecution history, stats, and pause/resume/cancel controls',
                ]}
              />
            }
          />
          <Route
            path="/monitoring"
            element={
              <ModulePlaceholderPage
                title="Workers & Monitoring"
                description="Observe distributed worker fleet heartbeats, throughput trends, stalled recovery, and audit logs."
                icon={<Activity className="h-5 w-5" />}
                milestoneLabel="Step 6.3 Planned"
                plannedCapabilities={[
                  'Live worker fleet health table (ONLINE / DEGRADED / STALE / STOPPED)',
                  'Trigger organisation-scoped stalled-job recovery and schedule reconciliation',
                  'Filterable audit event timeline for all job and worker lifecycle events',
                ]}
              />
            }
          />
          <Route
            path="/dlq"
            element={
              <ModulePlaceholderPage
                title="Dead Letter Queue"
                description="Inspect permanently failed jobs with redacted payloads and safely replay them."
                icon={<AlertOctagon className="h-5 w-5" />}
                milestoneLabel="Step 6.4 Planned"
                plannedCapabilities={[
                  'List OPEN and REPLAYED dead-letter records per queue and organisation',
                  'Review sanitized payload summaries, failure reasons, and exhausted attempt counts',
                  'Idempotently replay dead-lettered jobs with optional retry/priority overrides',
                ]}
              />
            }
          />
          <Route
            path="/settings"
            element={
              <ModulePlaceholderPage
                title="Organisation Settings"
                description="Manage workspace details, team memberships, RBAC roles, invitations, and ownership transfer."
                icon={<Settings className="h-5 w-5" />}
                milestoneLabel="Step 6.4 Planned"
                plannedCapabilities={[
                  'Rename or delete organisations (OWNER-protected)',
                  'Invite team members, update OWNER/ADMIN/MEMBER roles, and revoke pending invitations',
                  'Transfer organisation ownership safely with confirmation guards',
                ]}
              />
            }
          />
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <OrganisationProvider>
            <AppRoutes />
          </OrganisationProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Activity, AlertOctagon, Settings } from 'lucide-react';
import { queryClient } from './config/queryClient';
import { AuthProvider } from './contexts/AuthContext';
import { OrganisationProvider } from './contexts/OrganisationContext';
import { AppShell } from './components/layout/AppShell';
import { ProtectedRoute } from './components/routing/ProtectedRoute';
import { PublicOnlyRoute } from './components/routing/PublicOnlyRoute';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';
import { DashboardOverviewPage } from './pages/dashboard/DashboardOverviewPage';
import { JobDetailPage } from './pages/jobs/JobDetailPage';
import { JobsPage } from './pages/jobs/JobsPage';
import { ModulePlaceholderPage } from './pages/modules/ModulePlaceholderPage';
import { QueueDetailPage } from './pages/queues/QueueDetailPage';
import { QueuesPage } from './pages/queues/QueuesPage';
import { ScheduleDetailPage } from './pages/schedules/ScheduleDetailPage';
import { SchedulesPage } from './pages/schedules/SchedulesPage';

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
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/queues/:queueId" element={<QueueDetailPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/schedules/:scheduleId" element={<ScheduleDetailPage />} />
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

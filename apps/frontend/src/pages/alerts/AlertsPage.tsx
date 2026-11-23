import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  Edit2,
  Flame,
  Plus,
  Power,
  Radio,
  ShieldAlert,
  Sliders,
  Trash2,
} from 'lucide-react';
import { useOrganisation } from '../../contexts/OrganisationContext';
import { useQueuesList } from '../../hooks/useQueues';
import { useMonitoringStream, type UseMonitoringStreamOptions } from '../../hooks/useMonitoring';
import {
  useAcknowledgeAlert,
  useAlertRules,
  useAlerts,
  useAlertStats,
  useCreateAlertRule,
  useDeleteAlertRule,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useResolveAlert,
  useToggleAlertRule,
  useUpdateAlertRule,
} from '../../hooks/useAlerts';
import { AlertRuleFormModal, ALERT_TYPE_OPTIONS } from '../../components/alerts/AlertRuleFormModal';
import { PageContainer } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { MetricCard } from '../../components/ui/MetricCard';
import { StatusBadge } from '../../components/ui/StatusBadge';
import type {
  AlertComparisonOperator,
  AlertRuleView,
  AlertSeverity,
  AlertStatus,
  AlertType,
  AlertView,
} from '../../types/api';

type AlertsTab = 'alerts' | 'rules' | 'notifications';

function formatOperator(op: AlertComparisonOperator): string {
  switch (op) {
    case 'GT':
      return '>';
    case 'GTE':
      return '>=';
    case 'LT':
      return '<';
    case 'LTE':
      return '<=';
  }
}

function formatAlertType(type: AlertType): string {
  return ALERT_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type.replace(/_/g, ' ');
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export interface AlertsPageProps {
  streamOptions?: UseMonitoringStreamOptions;
}

export function AlertsPage({ streamOptions }: AlertsPageProps = {}) {
  const { activeOrganisation } = useOrganisation();
  const orgId = activeOrganisation?.id ?? null;
  const isAdminOrOwner =
    activeOrganisation?.role === 'OWNER' || activeOrganisation?.role === 'ADMIN';

  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<AlertsTab>('alerts');

  // Filters for Alerts tab
  const [statusFilter, setStatusFilter] = useState<AlertStatus | ''>('');
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | ''>('');
  const [typeFilter, setTypeFilter] = useState<AlertType | ''>('');
  const [alertsPage, setAlertsPage] = useState(1);

  // Selected alert for detail panel
  const [selectedAlert, setSelectedAlert] = useState<AlertView | null>(null);

  // Rule modal & delete confirmation
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRuleView | null>(null);
  const [deletingRule, setDeletingRule] = useState<AlertRuleView | null>(null);
  const [ruleFormError, setRuleFormError] = useState<string | null>(null);

  // Notifications tab state
  const [notifPage, setNotifPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);

  // Connect to org SSE stream so ALERT_FIRED / ALERT_ACKNOWLEDGED / ALERT_RESOLVED update live
  const stream = useMonitoringStream(orgId, streamOptions);

  const queuesQuery = useQueuesList(orgId);
  const statsQuery = useAlertStats(orgId, {
    refetchInterval: stream.fallbackRefetchInterval,
  });
  const alertsQuery = useAlerts(
    orgId,
    {
      page: alertsPage,
      limit: 20,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(severityFilter ? { severity: severityFilter } : {}),
      ...(typeFilter ? { type: typeFilter } : {}),
    },
    { refetchInterval: stream.fallbackRefetchInterval },
  );
  const rulesQuery = useAlertRules(orgId);
  const notificationsQuery = useNotifications(
    orgId,
    { page: notifPage, limit: 20, unreadOnly },
    { enabled: activeTab === 'notifications' },
  );

  const createRule = useCreateAlertRule(orgId);
  const updateRule = useUpdateAlertRule(orgId);
  const toggleRule = useToggleAlertRule(orgId);
  const deleteRule = useDeleteAlertRule(orgId);
  const acknowledgeAlert = useAcknowledgeAlert(orgId);
  const resolveAlert = useResolveAlert(orgId);
  const markNotifRead = useMarkNotificationRead(orgId);
  const markAllNotifsRead = useMarkAllNotificationsRead(orgId);

  // Auto-select alert from ?alertId=... query param when loaded
  const alertIdParam = searchParams.get('alertId');
  useEffect(() => {
    if (!alertIdParam || !alertsQuery.data?.alerts) return;
    const match = alertsQuery.data.alerts.find((a) => a.id === alertIdParam);
    if (match) {
      setSelectedAlert(match);
      setActiveTab('alerts');
    }
  }, [alertIdParam, alertsQuery.data]);

  // Keep selectedAlert synchronized with refreshed query data
  useEffect(() => {
    if (!selectedAlert || !alertsQuery.data?.alerts) return;
    const updated = alertsQuery.data.alerts.find((a) => a.id === selectedAlert.id);
    if (updated) {
      setSelectedAlert(updated);
    }
  }, [alertsQuery.data, selectedAlert]);

  const stats = statsQuery.data;
  const alerts = alertsQuery.data?.alerts ?? [];
  const alertsPagination = alertsQuery.data?.pagination;
  const rules = rulesQuery.data ?? [];
  const queues = queuesQuery.data ?? [];
  const notifications = notificationsQuery.data?.notifications ?? [];
  const notifPagination = notificationsQuery.data?.pagination;

  const handleOpenCreateRule = () => {
    setEditingRule(null);
    setRuleFormError(null);
    setRuleModalOpen(true);
  };

  const handleOpenEditRule = (rule: AlertRuleView) => {
    setEditingRule(rule);
    setRuleFormError(null);
    setRuleModalOpen(true);
  };

  const handleSelectAlert = (alert: AlertView) => {
    setSelectedAlert(alert);
    setSearchParams({ alertId: alert.id }, { replace: true });
  };

  return (
    <PageContainer
      title="Alerts & Notifications"
      description="Monitor threshold breaches, manage alerting rules, and review operational notifications."
      actions={
        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-slate-300">
            <Radio
              className={`h-3.5 w-3.5 ${stream.isLive ? 'text-emerald-400' : 'text-amber-400'}`}
            />
            <span>{stream.isLive ? 'Live stream' : 'Polling fallback'}</span>
          </div>
          {isAdminOrOwner && (
            <Button size="sm" onClick={handleOpenCreateRule}>
              <Plus className="h-3.5 w-3.5" />
              Create Rule
            </Button>
          )}
        </div>
      }
    >
      {/* Overview KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
        <MetricCard
          label="Firing Alerts"
          value={stats?.firing ?? 0}
          subtext="Requires attention"
          icon={<Flame className="h-4 w-4" />}
          tone={(stats?.firing ?? 0) > 0 ? 'danger' : 'default'}
          isLoading={statsQuery.isLoading}
        />
        <MetricCard
          label="Acknowledged"
          value={stats?.acknowledged ?? 0}
          subtext="Under investigation"
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={(stats?.acknowledged ?? 0) > 0 ? 'warning' : 'default'}
          isLoading={statsQuery.isLoading}
        />
        <MetricCard
          label="Critical Active"
          value={stats?.activeBySeverity.critical ?? 0}
          subtext={`${stats?.activeBySeverity.warning ?? 0} warning · ${stats?.activeBySeverity.info ?? 0} info`}
          icon={<ShieldAlert className="h-4 w-4" />}
          tone={(stats?.activeBySeverity.critical ?? 0) > 0 ? 'danger' : 'default'}
          isLoading={statsQuery.isLoading}
        />
        <MetricCard
          label="Resolved Alerts"
          value={stats?.resolved ?? 0}
          subtext={`${stats?.total ?? 0} total historical`}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="success"
          isLoading={statsQuery.isLoading}
        />
        <MetricCard
          label="Enabled Rules"
          value={`${stats?.enabledRules ?? 0} / ${stats?.totalRules ?? 0}`}
          subtext="Active alert policies"
          icon={<Sliders className="h-4 w-4" />}
          isLoading={statsQuery.isLoading}
        />
      </div>

      {/* Tab Navigation */}
      <div
        role="tablist"
        aria-label="Alerts sections"
        className="mb-5 flex items-center gap-1 border-b border-border-subtle"
      >
        {(
          [
            { id: 'alerts', label: 'Alerts', count: stats?.firing ?? 0 },
            { id: 'rules', label: 'Alert Rules', count: rules.length },
            { id: 'notifications', label: 'Notifications History' },
          ] as { id: AlertsTab; label: string; count?: number }[]
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition-colors ${
                isActive
                  ? 'border-sky-400 text-sky-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <span className="rounded-full bg-surface-elevated px-1.5 py-0.5 text-[10px] font-mono text-slate-300">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ─── TAB 1: ALERTS ─────────────────────────────────────────────────── */}
      {activeTab === 'alerts' && (
        <div className="space-y-4">
          {/* Filters */}
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 py-3">
              <select
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as AlertStatus | '');
                  setAlertsPage(1);
                }}
                className="rounded-lg border border-border-subtle bg-canvas px-2.5 py-1.5 text-xs text-slate-200 focus:border-sky-400 focus:outline-none"
              >
                <option value="">All statuses</option>
                <option value="FIRING">Firing</option>
                <option value="ACKNOWLEDGED">Acknowledged</option>
                <option value="RESOLVED">Resolved</option>
              </select>

              <select
                aria-label="Filter by severity"
                value={severityFilter}
                onChange={(e) => {
                  setSeverityFilter(e.target.value as AlertSeverity | '');
                  setAlertsPage(1);
                }}
                className="rounded-lg border border-border-subtle bg-canvas px-2.5 py-1.5 text-xs text-slate-200 focus:border-sky-400 focus:outline-none"
              >
                <option value="">All severities</option>
                <option value="CRITICAL">Critical</option>
                <option value="WARNING">Warning</option>
                <option value="INFO">Info</option>
              </select>

              <select
                aria-label="Filter by alert type"
                value={typeFilter}
                onChange={(e) => {
                  setTypeFilter(e.target.value as AlertType | '');
                  setAlertsPage(1);
                }}
                className="rounded-lg border border-border-subtle bg-canvas px-2.5 py-1.5 text-xs text-slate-200 focus:border-sky-400 focus:outline-none"
              >
                <option value="">All metric types</option>
                {ALERT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              {(statusFilter || severityFilter || typeFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setStatusFilter('');
                    setSeverityFilter('');
                    setTypeFilter('');
                    setAlertsPage(1);
                  }}
                  className="text-xs font-medium text-sky-400 hover:text-sky-300"
                >
                  Clear filters
                </button>
              )}
            </CardContent>
          </Card>

          {alertsQuery.isError ? (
            <ErrorState
              title="Failed to load alerts"
              message="Could not fetch alerts for this organisation."
              onRetry={() => void alertsQuery.refetch()}
            />
          ) : alertsQuery.isLoading ? (
            <Card>
              <CardContent className="py-10 text-center text-xs text-slate-400">
                Loading alerts…
              </CardContent>
            </Card>
          ) : alerts.length === 0 ? (
            <EmptyState
              icon={<Bell className="h-5 w-5" />}
              title="No alerts match your filters"
              description="When an enabled alert rule breaches its threshold, active and historical alerts will appear here."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className={selectedAlert ? 'lg:col-span-2' : 'lg:col-span-3'}>
                <Card>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-border-subtle bg-surface-subtle/50 text-[11px] uppercase tracking-wider text-slate-400">
                        <tr>
                          <th className="px-4 py-3">Alert</th>
                          <th className="px-4 py-3">Severity</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Observed / Threshold</th>
                          <th className="px-4 py-3">Last Triggered</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-subtle">
                        {alerts.map((alert) => {
                          const isSelected = selectedAlert?.id === alert.id;
                          return (
                            <tr
                              key={alert.id}
                              onClick={() => handleSelectAlert(alert)}
                              className={`cursor-pointer transition-colors hover:bg-surface-elevated ${
                                isSelected ? 'bg-sky-500/[0.06]' : ''
                              }`}
                            >
                              <td className="px-4 py-3">
                                <p className="font-semibold text-slate-100">{alert.ruleName}</p>
                                <p className="mt-0.5 text-[11px] text-slate-400">
                                  {formatAlertType(alert.type)}
                                  {alert.queueName ? ` · Queue: ${alert.queueName}` : ' · Org-wide'}
                                </p>
                              </td>
                              <td className="px-4 py-3">
                                <StatusBadge status={alert.severity} />
                              </td>
                              <td className="px-4 py-3">
                                <StatusBadge status={alert.status} showDot />
                              </td>
                              <td className="px-4 py-3 font-mono text-slate-200">
                                {alert.metricValue} / {alert.threshold}
                                {alert.occurrenceCount > 1 && (
                                  <span className="ml-1.5 text-[10px] text-slate-400">
                                    (×{alert.occurrenceCount})
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-400">
                                {formatTimestamp(alert.lastTriggeredAt)}
                              </td>
                              <td
                                className="px-4 py-3 text-right"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="inline-flex items-center gap-1.5">
                                  {alert.status === 'FIRING' && (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={acknowledgeAlert.isPending}
                                      onClick={() => acknowledgeAlert.mutate(alert.id)}
                                    >
                                      Acknowledge
                                    </Button>
                                  )}
                                  {isAdminOrOwner && alert.status !== 'RESOLVED' && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={resolveAlert.isPending}
                                      onClick={() => resolveAlert.mutate({ alertId: alert.id })}
                                    >
                                      Resolve
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {alertsPagination && alertsPagination.totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-border-subtle px-4 py-3 text-xs text-slate-400">
                      <span>
                        Page {alertsPagination.page} of {alertsPagination.totalPages} (
                        {alertsPagination.total} total)
                      </span>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!alertsPagination.hasPreviousPage}
                          onClick={() => setAlertsPage((p) => Math.max(1, p - 1))}
                        >
                          Previous
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!alertsPagination.hasNextPage}
                          onClick={() => setAlertsPage((p) => p + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              </div>

              {/* Alert Detail Panel */}
              {selectedAlert && (
                <Card className="h-fit">
                  <CardHeader
                    title={selectedAlert.ruleName}
                    description={formatAlertType(selectedAlert.type)}
                    action={
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAlert(null);
                          setSearchParams({}, { replace: true });
                        }}
                        className="text-xs text-slate-400 hover:text-slate-100"
                      >
                        Close
                      </button>
                    }
                  />
                  <CardContent className="space-y-3 text-xs">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={selectedAlert.severity} />
                      <StatusBadge status={selectedAlert.status} showDot />
                    </div>
                    <p className="rounded-lg border border-border-subtle bg-canvas p-3 text-slate-200">
                      {selectedAlert.message}
                    </p>
                    <dl className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <dt className="text-slate-500">Observed Value</dt>
                        <dd className="font-mono font-semibold text-slate-100">
                          {selectedAlert.metricValue}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Threshold</dt>
                        <dd className="font-mono font-semibold text-slate-100">
                          {selectedAlert.threshold}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Occurrences</dt>
                        <dd className="font-mono text-slate-200">
                          {selectedAlert.occurrenceCount}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Scope</dt>
                        <dd className="text-slate-200">
                          {selectedAlert.queueName ?? 'Organisation-wide'}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-slate-500">First Triggered</dt>
                        <dd className="text-slate-200">
                          {formatTimestamp(selectedAlert.firstTriggeredAt)}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-slate-500">Last Evaluated</dt>
                        <dd className="text-slate-200">
                          {formatTimestamp(selectedAlert.lastEvaluatedAt)}
                        </dd>
                      </div>
                      {selectedAlert.acknowledgedAt && (
                        <div className="col-span-2">
                          <dt className="text-slate-500">Acknowledged At</dt>
                          <dd className="text-amber-300">
                            {formatTimestamp(selectedAlert.acknowledgedAt)}
                          </dd>
                        </div>
                      )}
                      {selectedAlert.resolvedAt && (
                        <div className="col-span-2">
                          <dt className="text-slate-500">Resolved At</dt>
                          <dd className="text-emerald-300">
                            {formatTimestamp(selectedAlert.resolvedAt)}
                            {selectedAlert.resolutionReason
                              ? ` — ${selectedAlert.resolutionReason}`
                              : ''}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── TAB 2: ALERT RULES ────────────────────────────────────────────── */}
      {activeTab === 'rules' && (
        <div className="space-y-4">
          {!isAdminOrOwner && (
            <div className="rounded-lg border border-border-subtle bg-surface px-4 py-2.5 text-xs text-slate-400">
              You have read-only access to alert rules. Ask an organisation Admin or Owner to
              create, edit, or delete rules.
            </div>
          )}

          {rulesQuery.isError ? (
            <ErrorState
              title="Failed to load alert rules"
              message="Could not fetch alert rules for this organisation."
              onRetry={() => void rulesQuery.refetch()}
            />
          ) : rulesQuery.isLoading ? (
            <Card>
              <CardContent className="py-10 text-center text-xs text-slate-400">
                Loading alert rules…
              </CardContent>
            </Card>
          ) : rules.length === 0 ? (
            <EmptyState
              icon={<Sliders className="h-5 w-5" />}
              title="No alert rules configured"
              description="Create your first threshold rule to automatically detect queue backlogs, failure spikes, DLQ growth, or stale workers."
              action={
                isAdminOrOwner ? (
                  <Button size="sm" onClick={handleOpenCreateRule}>
                    <Plus className="h-3.5 w-3.5" />
                    Create Rule
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border-subtle bg-surface-subtle/50 text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Rule</th>
                      <th className="px-4 py-3">Condition</th>
                      <th className="px-4 py-3">Window / Cooldown</th>
                      <th className="px-4 py-3">Severity</th>
                      <th className="px-4 py-3">State</th>
                      {isAdminOrOwner && <th className="px-4 py-3 text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {rules.map((rule) => (
                      <tr key={rule.id} className="hover:bg-surface-elevated">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-100">{rule.name}</p>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            {rule.queueName ? `Queue: ${rule.queueName}` : 'All queues'}
                            {rule.description ? ` · ${rule.description}` : ''}
                          </p>
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-200">
                          {formatAlertType(rule.type)} {formatOperator(rule.operator)}{' '}
                          {rule.threshold}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-400">
                          {rule.windowMinutes}m / {rule.cooldownSeconds}s
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={rule.severity} />
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge
                            status={rule.isEnabled ? 'ACTIVE' : 'PAUSED'}
                            label={rule.isEnabled ? 'Enabled' : 'Disabled'}
                            showDot
                          />
                        </td>
                        {isAdminOrOwner && (
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={
                                  rule.isEnabled ? `Disable ${rule.name}` : `Enable ${rule.name}`
                                }
                                onClick={() =>
                                  toggleRule.mutate({
                                    ruleId: rule.id,
                                    isEnabled: !rule.isEnabled,
                                  })
                                }
                                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-sky-300"
                                title={rule.isEnabled ? 'Disable rule' : 'Enable rule'}
                              >
                                <Power className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Edit ${rule.name}`}
                                onClick={() => handleOpenEditRule(rule)}
                                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                                title="Edit rule"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete ${rule.name}`}
                                onClick={() => setDeletingRule(rule)}
                                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-300"
                                title="Delete rule"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ─── TAB 3: NOTIFICATIONS HISTORY ──────────────────────────────────── */}
      {activeTab === 'notifications' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => {
                  setUnreadOnly(e.target.checked);
                  setNotifPage(1);
                }}
                className="h-3.5 w-3.5 rounded border-border-strong bg-canvas text-sky-500"
              />
              Show unread only
            </label>

            {(notificationsQuery.data?.unreadCount ?? 0) > 0 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={markAllNotifsRead.isPending}
                onClick={() => markAllNotifsRead.mutate()}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </Button>
            )}
          </div>

          {notificationsQuery.isError ? (
            <ErrorState
              title="Failed to load notifications"
              message="Could not fetch notification history."
              onRetry={() => void notificationsQuery.refetch()}
            />
          ) : notificationsQuery.isLoading ? (
            <Card>
              <CardContent className="py-10 text-center text-xs text-slate-400">
                Loading notifications…
              </CardContent>
            </Card>
          ) : notifications.length === 0 ? (
            <EmptyState
              icon={<Bell className="h-5 w-5" />}
              title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
              description="Alert firing and recovery notifications for your organisation will appear here."
            />
          ) : (
            <Card>
              <div className="divide-y divide-border-subtle">
                {notifications.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-start justify-between gap-4 px-4 py-3 ${
                      !item.isRead ? 'bg-sky-500/[0.04]' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!item.isRead && (
                          <span className="h-2 w-2 rounded-full bg-sky-400 shrink-0" />
                        )}
                        <StatusBadge status={item.severity} />
                        <span className="text-[11px] text-slate-500">
                          {formatTimestamp(item.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-semibold text-slate-100">{item.title}</p>
                      <p className="mt-0.5 text-xs text-slate-400">{item.message}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {!item.isRead && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={markNotifRead.isPending}
                          onClick={() => markNotifRead.mutate(item.id)}
                        >
                          <Check className="h-3.5 w-3.5" />
                          Mark read
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {notifPagination && notifPagination.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border-subtle px-4 py-3 text-xs text-slate-400">
                  <span>
                    Page {notifPagination.page} of {notifPagination.totalPages}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!notifPagination.hasPreviousPage}
                      onClick={() => setNotifPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!notifPagination.hasNextPage}
                      onClick={() => setNotifPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* Create / Edit Alert Rule Modal */}
      <AlertRuleFormModal
        isOpen={ruleModalOpen}
        onClose={() => {
          setRuleModalOpen(false);
          setEditingRule(null);
          setRuleFormError(null);
        }}
        editingRule={editingRule}
        queues={queues}
        isSubmitting={createRule.isPending || updateRule.isPending}
        errorMessage={ruleFormError}
        onSubmitCreate={(payload) => {
          setRuleFormError(null);
          createRule.mutate(payload, {
            onSuccess: () => {
              setRuleModalOpen(false);
              setActiveTab('rules');
            },
            onError: (err) => {
              setRuleFormError(err instanceof Error ? err.message : 'Failed to create rule');
            },
          });
        }}
        onSubmitUpdate={(ruleId, payload) => {
          setRuleFormError(null);
          updateRule.mutate(
            { ruleId, payload },
            {
              onSuccess: () => {
                setRuleModalOpen(false);
                setEditingRule(null);
              },
              onError: (err) => {
                setRuleFormError(err instanceof Error ? err.message : 'Failed to update rule');
              },
            },
          );
        }}
      />

      {/* Delete Rule Confirmation Dialog */}
      <ConfirmDialog
        isOpen={Boolean(deletingRule)}
        onClose={() => setDeletingRule(null)}
        title="Delete Alert Rule"
        description={
          deletingRule
            ? `Delete "${deletingRule.name}"? Historical alerts generated by this rule will be preserved.`
            : ''
        }
        confirmLabel="Delete Rule"
        destructive
        isLoading={deleteRule.isPending}
        onConfirm={() => {
          if (!deletingRule) return;
          deleteRule.mutate(deletingRule.id, {
            onSuccess: () => setDeletingRule(null),
          });
        }}
      />
    </PageContainer>
  );
}

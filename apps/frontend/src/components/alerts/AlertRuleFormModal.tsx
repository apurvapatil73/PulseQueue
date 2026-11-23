import React, { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import type {
  AlertComparisonOperator,
  AlertRuleView,
  AlertSeverity,
  AlertType,
  CreateAlertRulePayload,
  QueueView,
  UpdateAlertRulePayload,
} from '../../types/api';

export const ALERT_TYPE_OPTIONS: {
  value: AlertType;
  label: string;
  unit: string;
  supportsQueue: boolean;
}[] = [
  { value: 'QUEUE_BACKLOG', label: 'Queue Backlog', unit: 'jobs', supportsQueue: true },
  { value: 'QUEUE_WAIT_TIME', label: 'Queue Wait Time', unit: 'ms', supportsQueue: true },
  { value: 'JOB_FAILURE_RATE', label: 'Job Failure Rate', unit: '%', supportsQueue: true },
  { value: 'JOB_RETRY_RATE', label: 'Job Retry Rate', unit: '%', supportsQueue: true },
  {
    value: 'DLQ_COUNT',
    label: 'Dead Letter Queue Count',
    unit: 'open DLQ items',
    supportsQueue: true,
  },
  { value: 'WORKER_STALE', label: 'Stale Workers', unit: 'workers', supportsQueue: false },
  { value: 'JOB_LATENCY_P95', label: 'Job P95 Latency', unit: 'ms', supportsQueue: true },
  {
    value: 'SCHEDULE_MISFIRES',
    label: 'Schedule Misfires',
    unit: 'misfires',
    supportsQueue: false,
  },
];

const OPERATOR_OPTIONS: { value: AlertComparisonOperator; label: string }[] = [
  { value: 'GTE', label: '>= (Greater or equal)' },
  { value: 'GT', label: '> (Greater than)' },
  { value: 'LTE', label: '<= (Less or equal)' },
  { value: 'LT', label: '< (Less than)' },
];

const SEVERITY_OPTIONS: AlertSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

interface AlertRuleFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingRule?: AlertRuleView | null;
  queues: QueueView[];
  isSubmitting: boolean;
  errorMessage?: string | null;
  onSubmitCreate: (payload: CreateAlertRulePayload) => void;
  onSubmitUpdate: (ruleId: string, payload: UpdateAlertRulePayload) => void;
}

export function AlertRuleFormModal({
  isOpen,
  onClose,
  editingRule,
  queues,
  isSubmitting,
  errorMessage,
  onSubmitCreate,
  onSubmitUpdate,
}: AlertRuleFormModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<AlertType>('QUEUE_BACKLOG');
  const [operator, setOperator] = useState<AlertComparisonOperator>('GTE');
  const [threshold, setThreshold] = useState('10');
  const [windowMinutes, setWindowMinutes] = useState('15');
  const [cooldownSeconds, setCooldownSeconds] = useState('300');
  const [queueId, setQueueId] = useState<string>('');
  const [severity, setSeverity] = useState<AlertSeverity>('WARNING');
  const [isEnabled, setIsEnabled] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLocalError(null);
    if (editingRule) {
      setName(editingRule.name);
      setDescription(editingRule.description ?? '');
      setType(editingRule.type);
      setOperator(editingRule.operator);
      setThreshold(String(editingRule.threshold));
      setWindowMinutes(String(editingRule.windowMinutes));
      setCooldownSeconds(String(editingRule.cooldownSeconds));
      setQueueId(editingRule.queueId ?? '');
      setSeverity(editingRule.severity);
      setIsEnabled(editingRule.isEnabled);
    } else {
      setName('');
      setDescription('');
      setType('QUEUE_BACKLOG');
      setOperator('GTE');
      setThreshold('10');
      setWindowMinutes('15');
      setCooldownSeconds('300');
      setQueueId('');
      setSeverity('WARNING');
      setIsEnabled(true);
    }
  }, [isOpen, editingRule]);

  const selectedTypeMeta =
    ALERT_TYPE_OPTIONS.find((opt) => opt.value === type) ?? ALERT_TYPE_OPTIONS[0];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setLocalError('Rule name must be at least 2 characters.');
      return;
    }

    const numThreshold = Number(threshold);
    const numWindow = Number(windowMinutes);
    const numCooldown = Number(cooldownSeconds);

    if (!Number.isFinite(numThreshold) || numThreshold < 0) {
      setLocalError('Threshold must be a non-negative number.');
      return;
    }

    if ((type === 'JOB_FAILURE_RATE' || type === 'JOB_RETRY_RATE') && numThreshold > 100) {
      setLocalError('Percentage threshold must be between 0 and 100.');
      return;
    }

    if (!Number.isInteger(numWindow) || numWindow < 1 || numWindow > 1440) {
      setLocalError('Evaluation window must be an integer between 1 and 1440 minutes.');
      return;
    }

    if (!Number.isInteger(numCooldown) || numCooldown < 0 || numCooldown > 86400) {
      setLocalError('Cooldown must be an integer between 0 and 86400 seconds.');
      return;
    }

    const resolvedQueueId = selectedTypeMeta.supportsQueue && queueId ? queueId : null;

    if (editingRule) {
      onSubmitUpdate(editingRule.id, {
        name: trimmedName,
        description: description.trim() || null,
        operator,
        threshold: numThreshold,
        windowMinutes: numWindow,
        cooldownSeconds: numCooldown,
        queueId: resolvedQueueId,
        severity,
        isEnabled,
      });
    } else {
      onSubmitCreate({
        name: trimmedName,
        description: description.trim() || null,
        type,
        operator,
        threshold: numThreshold,
        windowMinutes: numWindow,
        cooldownSeconds: numCooldown,
        queueId: resolvedQueueId,
        severity,
        isEnabled,
      });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editingRule ? 'Edit Alert Rule' : 'Create Alert Rule'}
      description="Configure threshold-based operational alerting for this organisation."
    >
      <form onSubmit={handleSubmit} className="space-y-3.5">
        {(localError || errorMessage) && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
          >
            {localError ?? errorMessage}
          </div>
        )}

        <div>
          <label htmlFor="alert-rule-name" className="block text-xs font-medium text-slate-300">
            Rule Name
          </label>
          <input
            id="alert-rule-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. High Queue Backlog"
            required
            className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="alert-rule-description"
            className="block text-xs font-medium text-slate-300"
          >
            Description (optional)
          </label>
          <input
            id="alert-rule-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this alert indicate?"
            className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="alert-rule-type" className="block text-xs font-medium text-slate-300">
              Metric Type
            </label>
            <select
              id="alert-rule-type"
              value={type}
              disabled={Boolean(editingRule)}
              onChange={(e) => {
                const nextType = e.target.value as AlertType;
                setType(nextType);
                const meta = ALERT_TYPE_OPTIONS.find((o) => o.value === nextType);
                if (meta && !meta.supportsQueue) {
                  setQueueId('');
                }
              }}
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-2.5 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none disabled:opacity-60"
            >
              {ALERT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="alert-rule-severity"
              className="block text-xs font-medium text-slate-300"
            >
              Severity
            </label>
            <select
              id="alert-rule-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as AlertSeverity)}
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-2.5 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            >
              {SEVERITY_OPTIONS.map((sev) => (
                <option key={sev} value={sev}>
                  {sev}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="alert-rule-operator"
              className="block text-xs font-medium text-slate-300"
            >
              Operator
            </label>
            <select
              id="alert-rule-operator"
              value={operator}
              onChange={(e) => setOperator(e.target.value as AlertComparisonOperator)}
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-2.5 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            >
              {OPERATOR_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="alert-rule-threshold"
              className="block text-xs font-medium text-slate-300"
            >
              Threshold ({selectedTypeMeta.unit})
            </label>
            <input
              id="alert-rule-threshold"
              type="number"
              step="any"
              min="0"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="alert-rule-window" className="block text-xs font-medium text-slate-300">
              Evaluation Window (min)
            </label>
            <input
              id="alert-rule-window"
              type="number"
              min="1"
              max="1440"
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="alert-rule-cooldown"
              className="block text-xs font-medium text-slate-300"
            >
              Cooldown (seconds)
            </label>
            <input
              id="alert-rule-cooldown"
              type="number"
              min="0"
              max="86400"
              value={cooldownSeconds}
              onChange={(e) => setCooldownSeconds(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            />
          </div>
        </div>

        {selectedTypeMeta.supportsQueue && (
          <div>
            <label htmlFor="alert-rule-queue" className="block text-xs font-medium text-slate-300">
              Queue Scope (optional)
            </label>
            <select
              id="alert-rule-queue"
              value={queueId}
              onChange={(e) => setQueueId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border-subtle bg-canvas px-2.5 py-2 text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            >
              <option value="">All queues (organisation-wide)</option>
              {queues.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => setIsEnabled(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong bg-canvas text-sky-500"
          />
          Rule enabled immediately
        </label>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-surface-elevated"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : editingRule ? 'Save Changes' : 'Create Rule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

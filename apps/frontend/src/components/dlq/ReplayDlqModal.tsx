import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Braces, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { ApiClientError } from '../../api/error';
import { useJobDetail } from '../../hooks/useJobs';
import type { DeadLetterJobView, ReplayDlqPayload, ReplayDlqResult } from '../../types/api';
import { JOB_LIMITS } from '../jobs/SubmitJobModal';
import { QUEUE_LIMITS } from '../queues/QueueFormModal';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';

export interface ReplayDlqModalProps {
  isOpen: boolean;
  organisationId: string | null;
  dlqItem: DeadLetterJobView | null;
  onClose: () => void;
  onConfirmReplay: (dlqId: string, overrides: ReplayDlqPayload) => Promise<ReplayDlqResult>;
  onSuccess?: (result: ReplayDlqResult, message: string) => void;
}

function parseJsonObject(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'Payload must be a JSON object (e.g. { "key": "value" })' };
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(parsed)).length;
    if (byteLength > JOB_LIMITS.MAX_PAYLOAD_BYTES) {
      return {
        ok: false,
        error: `Payload must not exceed ${JOB_LIMITS.MAX_PAYLOAD_BYTES} bytes when serialized`,
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON syntax: ${err instanceof Error ? err.message : 'Unable to parse JSON'}`,
    };
  }
}

export function ReplayDlqModal({
  isOpen,
  organisationId,
  dlqItem,
  onClose,
  onConfirmReplay,
  onSuccess,
}: ReplayDlqModalProps) {
  const [isReplaying, setIsReplaying] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const [priorityText, setPriorityText] = useState('');
  const [maxRetriesText, setMaxRetriesText] = useState('');
  const [backoffMsText, setBackoffMsText] = useState('');
  const [overridePayloadEnabled, setOverridePayloadEnabled] = useState(false);
  const [payloadText, setPayloadText] = useState('{}');
  const [validationError, setValidationError] = useState<string | null>(null);

  const originalJobQuery = useJobDetail(
    isOpen && customizeOpen ? organisationId : null,
    isOpen && customizeOpen && dlqItem ? dlqItem.originalJobId : null,
  );

  useEffect(() => {
    if (!isOpen) return;
    setServerError(null);
    setValidationError(null);
    setCustomizeOpen(false);
    setPriorityText('');
    setMaxRetriesText(dlqItem ? String(dlqItem.maxRetries) : '');
    setBackoffMsText('');
    setOverridePayloadEnabled(false);
    setPayloadText('{}');
  }, [isOpen, dlqItem]);

  useEffect(() => {
    if (originalJobQuery.data && !overridePayloadEnabled) {
      setPayloadText(JSON.stringify(originalJobQuery.data.payload ?? {}, null, 2));
    }
  }, [originalJobQuery.data, overridePayloadEnabled]);

  const payloadBytes = useMemo(
    () => new TextEncoder().encode(payloadText ?? '').length,
    [payloadText],
  );

  if (!dlqItem) return null;

  const handleFormatJson = () => {
    const parsed = parseJsonObject(payloadText);
    if (parsed.ok) {
      setPayloadText(JSON.stringify(parsed.value, null, 2));
      setValidationError(null);
    } else {
      setValidationError(parsed.error);
    }
  };

  const handleReplay = async () => {
    setServerError(null);
    setValidationError(null);

    const overrides: ReplayDlqPayload = {};

    if (customizeOpen) {
      if (priorityText.trim() !== '') {
        const p = Number(priorityText.trim());
        if (
          !Number.isInteger(p) ||
          p < QUEUE_LIMITS.MIN_PRIORITY ||
          p > QUEUE_LIMITS.MAX_PRIORITY
        ) {
          setValidationError(
            `Priority must be an integer between ${QUEUE_LIMITS.MIN_PRIORITY} and ${QUEUE_LIMITS.MAX_PRIORITY}`,
          );
          return;
        }
        overrides.priority = p;
      }

      if (maxRetriesText.trim() !== '') {
        const r = Number(maxRetriesText.trim());
        if (
          !Number.isInteger(r) ||
          r < QUEUE_LIMITS.MIN_MAX_RETRIES ||
          r > QUEUE_LIMITS.MAX_MAX_RETRIES
        ) {
          setValidationError(
            `Max retries must be an integer between ${QUEUE_LIMITS.MIN_MAX_RETRIES} and ${QUEUE_LIMITS.MAX_MAX_RETRIES}`,
          );
          return;
        }
        overrides.maxRetries = r;
      }

      if (backoffMsText.trim() !== '') {
        const b = Number(backoffMsText.trim());
        if (
          !Number.isInteger(b) ||
          b < QUEUE_LIMITS.MIN_BACKOFF_MS ||
          b > QUEUE_LIMITS.MAX_BACKOFF_MS
        ) {
          setValidationError(
            `Backoff duration must be an integer between ${QUEUE_LIMITS.MIN_BACKOFF_MS} and ${QUEUE_LIMITS.MAX_BACKOFF_MS} ms`,
          );
          return;
        }
        overrides.backoffMs = b;
      }

      if (overridePayloadEnabled) {
        const parsed = parseJsonObject(payloadText);
        if (!parsed.ok) {
          setValidationError(parsed.error);
          return;
        }
        overrides.payload = parsed.value;
      }
    }

    setIsReplaying(true);
    try {
      const result = await onConfirmReplay(dlqItem.id, overrides);
      onSuccess?.(
        result,
        `Dead-letter job "${dlqItem.jobName}" replayed as new job ${result.replayedJob.id.slice(0, 8)} (${result.replayedJob.status}).`,
      );
      onClose();
    } catch (err) {
      setServerError(
        err instanceof ApiClientError
          ? err.message
          : 'Unable to replay dead-letter job. Please try again.',
      );
    } finally {
      setIsReplaying(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Replay Dead-Letter Job"
      description={`Re-enqueue failed job "${dlqItem.jobName}" into queue "${dlqItem.queueName}".`}
    >
      <div className="max-h-[78vh] space-y-4 overflow-y-auto pr-1">
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3.5 text-xs text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium text-amber-100">
                Replaying will execute this job processor again
              </p>
              <p className="text-amber-200/80">
                PulseQueue will atomically mark this DLQ record as{' '}
                <span className="font-mono font-semibold">REPLAYED</span>, create a new PostgreSQL
                job linked via <span className="font-mono">replayedFromDlqId</span>, and dispatch it
                to BullMQ while preserving the original failure history.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-canvas/60 px-3.5 py-2.5 text-xs">
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-400">Original Job ID</span>
            <span className="font-mono text-slate-200">{dlqItem.originalJobId}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-400">Target Queue</span>
            <span className="font-mono text-slate-200">{dlqItem.queueName}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-400">Previous Failure</span>
            <span
              className="font-mono text-rose-300 truncate max-w-[230px]"
              title={dlqItem.failureReason}
            >
              {dlqItem.failureReason}
            </span>
          </div>
        </div>

        {/* Optional Replay Overrides */}
        <div className="rounded-lg border border-border-subtle bg-surface-subtle/40">
          <button
            type="button"
            onClick={() => setCustomizeOpen((prev) => !prev)}
            aria-expanded={customizeOpen}
            className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-slate-200 hover:bg-surface-elevated/50 rounded-lg"
          >
            <span>Customize Replay Overrides (Optional)</span>
            {customizeOpen ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" />
            )}
          </button>

          {customizeOpen && (
            <div className="space-y-3 border-t border-border-subtle p-3.5">
              <div className="grid grid-cols-3 gap-2.5">
                <Input
                  id="replayPriority"
                  label="Priority (1–20)"
                  type="number"
                  placeholder="Original"
                  value={priorityText}
                  onChange={(e) => setPriorityText(e.target.value)}
                />
                <Input
                  id="replayMaxRetries"
                  label="Max Retries (0–20)"
                  type="number"
                  placeholder="Original"
                  value={maxRetriesText}
                  onChange={(e) => setMaxRetriesText(e.target.value)}
                />
                <Input
                  id="replayBackoffMs"
                  label="Backoff (ms)"
                  type="number"
                  placeholder="Original"
                  value={backoffMsText}
                  onChange={(e) => setBackoffMsText(e.target.value)}
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={overridePayloadEnabled}
                  onChange={(e) => setOverridePayloadEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-border-strong bg-canvas text-sky-400 focus:ring-sky-400/40"
                />
                <span>Override JSON payload for replayed job</span>
              </label>

              {overridePayloadEnabled && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="replayPayloadText"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Override JSON Payload
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-slate-500">
                        {payloadBytes.toLocaleString()} /{' '}
                        {JOB_LIMITS.MAX_PAYLOAD_BYTES.toLocaleString()} B
                      </span>
                      <button
                        type="button"
                        onClick={handleFormatJson}
                        className="inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-elevated px-2 py-0.5 text-[11px] text-slate-300 hover:border-border-strong"
                      >
                        <Braces className="h-3 w-3 text-sky-400" />
                        Format JSON
                      </button>
                    </div>
                  </div>
                  <textarea
                    id="replayPayloadText"
                    rows={4}
                    value={payloadText}
                    onChange={(e) => setPayloadText(e.target.value)}
                    className="w-full rounded-lg border border-border-subtle bg-canvas p-3 font-mono text-xs text-slate-100 focus:border-sky-400/70 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {validationError && <ErrorState compact message={validationError} />}
        {serverError && <ErrorState compact message={serverError} />}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isReplaying}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleReplay()}
            isLoading={isReplaying}
            leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
          >
            Confirm Replay
          </Button>
        </div>
      </div>
    </Modal>
  );
}

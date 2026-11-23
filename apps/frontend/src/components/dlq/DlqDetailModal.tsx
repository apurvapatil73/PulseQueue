import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Copy, ExternalLink, RotateCcw, ShieldAlert } from 'lucide-react';
import { useJobDetail, useJobEvents } from '../../hooks/useJobs';
import type { DeadLetterJobView, DeadLetterPayloadSummary } from '../../types/api';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Modal } from '../ui/Modal';
import { Skeleton } from '../ui/Skeleton';
import { StatusBadge } from '../ui/StatusBadge';

export interface DlqDetailModalProps {
  isOpen: boolean;
  organisationId: string | null;
  dlqItem: DeadLetterJobView | null;
  canReplay: boolean;
  onClose: () => void;
  onOpenReplay: (item: DeadLetterJobView) => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function extractPayloadSummary(raw: unknown): DeadLetterPayloadSummary {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      keyCount: typeof obj.keyCount === 'number' ? obj.keyCount : 0,
      keys: Array.isArray(obj.keys)
        ? obj.keys.filter((k): k is string => typeof k === 'string')
        : [],
      byteLength: typeof obj.byteLength === 'number' ? obj.byteLength : 0,
    };
  }
  return { keyCount: 0, keys: [], byteLength: 0 };
}

export function DlqDetailModal({
  isOpen,
  organisationId,
  dlqItem,
  canReplay,
  onClose,
  onOpenReplay,
}: DlqDetailModalProps) {
  const [copiedPayload, setCopiedPayload] = useState(false);

  const originalJobQuery = useJobDetail(
    isOpen ? organisationId : null,
    isOpen && dlqItem ? dlqItem.originalJobId : null,
  );

  const eventsQuery = useJobEvents(
    isOpen ? organisationId : null,
    isOpen && dlqItem ? dlqItem.originalJobId : null,
  );

  useEffect(() => {
    if (!isOpen) {
      setCopiedPayload(false);
    }
  }, [isOpen]);

  if (!dlqItem) return null;

  const summary = extractPayloadSummary(dlqItem.payloadSummary);
  const originalJob = originalJobQuery.data;
  const events = eventsQuery.data?.events ?? [];
  const retryEvents = events.filter(
    (e) =>
      e.type === 'JOB_RETRIED' ||
      e.type === 'JOB_FAILED' ||
      e.type === 'JOB_MOVED_TO_DLQ' ||
      e.type === 'JOB_STALLED',
  );

  const handleCopyPayload = async () => {
    if (!originalJob) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(originalJob.payload ?? {}, null, 2));
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Dead-Letter Record — ${dlqItem.jobName}`}
      description={`DLQ ID: ${dlqItem.id}`}
    >
      <div className="max-h-[78vh] space-y-4 overflow-y-auto pr-1">
        {/* Status & Core Lineage Metadata */}
        <div className="rounded-lg border border-border-subtle bg-canvas/60 p-3.5">
          <dl className="divide-y divide-border-subtle text-xs">
            <div className="flex items-center justify-between py-2 gap-2">
              <dt className="text-slate-400">DLQ Status</dt>
              <dd>
                <StatusBadge status={dlqItem.status} showDot />
              </dd>
            </div>
            <div className="flex items-center justify-between py-2 gap-2">
              <dt className="text-slate-400">Processor / Job Type</dt>
              <dd className="font-mono font-semibold text-slate-100">{dlqItem.jobName}</dd>
            </div>
            <div className="flex items-center justify-between py-2 gap-2">
              <dt className="text-slate-400">Queue</dt>
              <dd>
                <Link
                  to={`/queues/${dlqItem.queueId}`}
                  onClick={onClose}
                  className="inline-flex items-center gap-1 font-mono font-medium text-sky-300 hover:underline"
                >
                  {dlqItem.queueName}
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </dd>
            </div>
            <div className="flex items-center justify-between py-2 gap-2">
              <dt className="text-slate-400">Original Failed Job</dt>
              <dd>
                <Link
                  to={`/jobs/${dlqItem.originalJobId}`}
                  onClick={onClose}
                  className="inline-flex items-center gap-1 font-mono font-medium text-sky-300 hover:underline"
                >
                  {dlqItem.originalJobId.slice(0, 8)}…{dlqItem.originalJobId.slice(-4)}
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </dd>
            </div>
            <div className="flex items-center justify-between py-2 gap-2">
              <dt className="text-slate-400">Attempts Exhausted</dt>
              <dd className="font-mono text-slate-200">
                {dlqItem.attemptsMade} / {dlqItem.maxRetries + 1} ({dlqItem.maxRetries} max retries)
              </dd>
            </div>
            {originalJob && (
              <div className="flex items-center justify-between py-2 gap-2">
                <dt className="text-slate-400">Job Created At</dt>
                <dd className="font-mono text-slate-300">
                  {formatDateTime(originalJob.createdAt)}
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between py-2 gap-2">
              <dt className="text-slate-400">Failed At</dt>
              <dd className="font-mono text-rose-200">{formatDateTime(dlqItem.failedAt)}</dd>
            </div>
            {dlqItem.status === 'REPLAYED' && (
              <>
                <div className="flex items-center justify-between py-2 gap-2">
                  <dt className="text-sky-300">Replayed At</dt>
                  <dd className="font-mono text-sky-200">{formatDateTime(dlqItem.replayedAt)}</dd>
                </div>
                {dlqItem.replayedJobId && (
                  <div className="flex items-center justify-between py-2 gap-2">
                    <dt className="text-sky-300">Replayed Job</dt>
                    <dd>
                      <Link
                        to={`/jobs/${dlqItem.replayedJobId}`}
                        onClick={onClose}
                        className="inline-flex items-center gap-1 font-mono font-medium text-sky-300 hover:underline"
                      >
                        {dlqItem.replayedJobId.slice(0, 8)}…{dlqItem.replayedJobId.slice(-4)}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </div>

        {/* Failure Reason / Error Message Diagnostics */}
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-slate-300">
            Terminal Failure Reason &amp; Error Details
          </span>
          <div
            role="alert"
            className="max-h-44 overflow-y-auto rounded-lg border border-rose-500/30 bg-rose-500/10 p-3.5 text-xs text-rose-200"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <p className="font-mono whitespace-pre-wrap break-words">{dlqItem.failureReason}</p>
            </div>
          </div>
        </div>

        {/* Sanitized Payload Summary & Original Job JSON Payload */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">
              Original Job Payload ({summary.keyCount} key(s) · {summary.byteLength} B)
            </span>
            {originalJob && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCopyPayload()}
                leftIcon={
                  copiedPayload ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )
                }
              >
                {copiedPayload ? 'Copied' : 'Copy JSON'}
              </Button>
            )}
          </div>

          {summary.keys.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-slate-400 mr-1">Top-level keys:</span>
              {summary.keys.map((key) => (
                <span
                  key={key}
                  className="rounded border border-border-subtle bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
                >
                  {key}
                </span>
              ))}
            </div>
          )}

          {originalJobQuery.isLoading ? (
            <Skeleton className="h-28 w-full" />
          ) : originalJobQuery.error ? (
            <ErrorState
              compact
              message="Unable to load original job payload. Redacted payload summary keys are shown above."
            />
          ) : originalJob ? (
            <pre className="max-h-48 overflow-auto rounded-lg border border-border-subtle bg-canvas p-3.5 font-mono text-xs text-slate-200">
              {JSON.stringify(originalJob.payload ?? {}, null, 2)}
            </pre>
          ) : null}
        </div>

        {/* Retry & Failure Audit History */}
        {retryEvents.length > 0 && (
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-slate-300">
              Retry &amp; Failure Audit Trail
            </span>
            <ul className="space-y-1.5 rounded-lg border border-border-subtle bg-canvas/60 p-3">
              {retryEvents.map((evt) => (
                <li
                  key={evt.id}
                  className="flex flex-col gap-1 border-b border-border-subtle pb-1.5 last:border-b-0 last:pb-0 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={evt.type} />
                    <span className="font-mono text-[10px] text-slate-400">
                      {formatDateTime(evt.createdAt)}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300">{evt.message}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-2.5 border-t border-border-subtle pt-3">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <ShieldAlert className="h-3.5 w-3.5 text-slate-500" />
            <span>Original job &amp; DLQ audit records remain immutable</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            {canReplay && dlqItem.status === 'OPEN' && (
              <Button
                size="sm"
                leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={() => {
                  onClose();
                  onOpenReplay(dlqItem);
                }}
              >
                Replay Job
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

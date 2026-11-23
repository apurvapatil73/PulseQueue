import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ApiClientError } from '../../api/error';
import type { JobView } from '../../types/api';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Modal } from '../ui/Modal';

export interface CancelJobModalProps {
  isOpen: boolean;
  job: JobView | null;
  onClose: () => void;
  onConfirmCancel: (jobId: string) => Promise<unknown>;
  onSuccess?: (message: string) => void;
}

export function CancelJobModal({
  isOpen,
  job,
  onClose,
  onConfirmCancel,
  onSuccess,
}: CancelJobModalProps) {
  const [isCancelling, setIsCancelling] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setServerError(null);
    }
  }, [isOpen, job]);

  if (!job) return null;

  const handleCancelJob = async () => {
    setServerError(null);
    setIsCancelling(true);
    try {
      await onConfirmCancel(job.id);
      onSuccess?.(`Job "${job.name}" (${job.id.slice(0, 8)}) cancelled.`);
      onClose();
    } catch (err) {
      setServerError(
        err instanceof ApiClientError ? err.message : 'Unable to cancel job. Please try again.',
      );
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Cancel Job"
      description={`Remove pre-execution job "${job.name}" (${job.id.slice(0, 8)}) from PostgreSQL and BullMQ.`}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3.5 text-xs text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="space-y-1">
              <p className="font-medium text-amber-100">
                Only pre-execution jobs (PENDING, DELAYED, PAUSED) can be cancelled
              </p>
              <p className="text-amber-200/80">
                Current status: <span className="font-mono font-semibold">{job.status}</span>. If a
                worker claims or completes this job before cancellation finishes, the backend will
                reject the request with HTTP 409 Conflict.
              </p>
            </div>
          </div>
        </div>

        {serverError && <ErrorState compact message={serverError} />}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isCancelling}>
            Keep Job
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleCancelJob()}
            isLoading={isCancelling}
          >
            Confirm Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

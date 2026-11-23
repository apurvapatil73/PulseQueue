import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ApiClientError } from '../../api/error';
import type { QueueView } from '../../types/api';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/ErrorState';
import { Modal } from '../ui/Modal';

export interface DeleteQueueModalProps {
  isOpen: boolean;
  queue: QueueView | null;
  onClose: () => void;
  onConfirmDelete: (queueId: string) => Promise<void>;
  onSuccess?: (message: string) => void;
}

export function DeleteQueueModal({
  isOpen,
  queue,
  onClose,
  onConfirmDelete,
  onSuccess,
}: DeleteQueueModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setServerError(null);
    }
  }, [isOpen, queue]);

  if (!queue) return null;

  const handleDelete = async () => {
    setServerError(null);
    setIsDeleting(true);
    try {
      await onConfirmDelete(queue.id);
      onSuccess?.(`Queue "${queue.name}" deleted.`);
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setServerError(err.message);
      } else {
        setServerError('Unable to delete queue. Please try again.');
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Delete Queue"
      description={`Permanently remove "${queue.name}" from this organisation.`}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3.5 text-xs text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-amber-100">
                Deletion is blocked when jobs exist in the queue
              </p>
              <p className="text-amber-200/80">
                PulseQueue never deletes jobs automatically. This queue currently has{' '}
                <span className="font-mono font-semibold">{queue.jobCount}</span> persisted job(s).
                If jobs remain, the backend will reject deletion with HTTP 409 Conflict.
              </p>
            </div>
          </div>
        </div>

        {serverError && <ErrorState compact message={serverError} />}

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleDelete()}
            isLoading={isDeleting}
          >
            Delete Queue
          </Button>
        </div>
      </div>
    </Modal>
  );
}

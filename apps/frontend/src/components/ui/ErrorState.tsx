import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({
  title = 'Unable to load data',
  message,
  onRetry,
  compact = false,
}: ErrorStateProps) {
  if (compact) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200"
      >
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
          <span className="truncate">{message}</span>
        </div>
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0 text-rose-200">
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-rose-500/25 bg-rose-500/5 px-6 py-10 text-center"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-rose-500/30 bg-rose-500/10 text-rose-400">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-100">{title}</h3>
      <p className="mt-1 max-w-md text-xs text-slate-400">{message}</p>
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          className="mt-4"
        >
          Try again
        </Button>
      )}
    </div>
  );
}

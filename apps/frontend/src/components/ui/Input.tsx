import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className = '', ...props },
  ref,
) {
  const inputId = id ?? props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium text-slate-300">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        className={`w-full h-9 rounded-lg bg-canvas px-3 text-sm text-slate-100 placeholder:text-slate-500 border transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400/30 ${
          error
            ? 'border-rose-500/60 focus:border-rose-400'
            : 'border-border-subtle hover:border-border-strong focus:border-sky-400/70'
        } ${className}`}
        {...props}
      />
      {error ? (
        <p role="alert" className="text-xs text-rose-400">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
});

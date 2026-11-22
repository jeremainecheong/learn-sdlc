import { forwardRef } from 'react';

/**
 * A form field with a real, visible <label>. A placeholder disappears the
 * moment you type, so anyone who loses their place, or is using a screen
 * reader, has nothing left to tell them what the box is for.
 */
export const Field = forwardRef<
  HTMLInputElement,
  {
    id: string;
    label: string;
    hint?: string;
    error?: boolean;
  } & React.InputHTMLAttributes<HTMLInputElement>
>(function Field({ id, label, hint, error, className = '', ...props }, ref) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[13px] font-medium text-ink">
        {label}
      </label>
      <input
        {...props}
        id={id}
        ref={ref}
        aria-describedby={hintId}
        aria-invalid={error || undefined}
        className={`field mt-1.5 ${error ? 'border-fail focus:border-fail focus:ring-failtint' : ''} ${className}`}
      />
      {hint && (
        <p id={hintId} className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {hint}
        </p>
      )}
    </div>
  );
});

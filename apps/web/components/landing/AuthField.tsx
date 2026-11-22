"use client";
import { useState, type InputHTMLAttributes } from "react";
import { CircleAlert, Eye, EyeOff, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useHydrated } from "@/lib/useHydrated";

export function AuthField({
  id,
  label,
  hint,
  error,
  errorMessage,
  type = "text",
  className: _className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: string;
  error?: boolean;
  errorMessage?: string;
}) {
  const [visible, setVisible] = useState(false);
  const ready = useHydrated();
  const Icon =
    type === "password" ? LockKeyhole : type === "email" ? Mail : UserRound;
  return (
    <div>
      <label className="lh-entry-label" htmlFor={id}>
        {label}
      </label>
      <div className="lh-input-wrap">
        <Icon size={17} aria-hidden />
        <input
          {...props}
          disabled={props.disabled || !ready}
          id={id}
          type={type === "password" && visible ? "text" : type}
          aria-invalid={error || undefined}
          aria-describedby={[props['aria-describedby'], hint ? `${id}-hint` : '', errorMessage ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined}
        />
        {type === "password" && (
          <button
            type="button"
            disabled={!ready}
            className="lh-password-toggle"
            onClick={() => setVisible((value) => !value)}
            aria-label={visible ? "Hide password" : "Show password"}
          >
            {visible ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
      {errorMessage && <p id={`${id}-error`} role="alert" className="lh-input-hint text-fail" data-testid="auth-error"><CircleAlert size={15} aria-hidden="true" /><span>{errorMessage}</span></p>}
      {hint && (
        <p className="lh-input-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

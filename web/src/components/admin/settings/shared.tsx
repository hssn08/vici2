"use client";

// M05 — Shared primitives for the settings panel.

import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// SectionHeading
// ---------------------------------------------------------------------------

export function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <h2 className="text-base font-semibold text-[var(--color-fg)] mb-4">{children}</h2>
  );
}

// ---------------------------------------------------------------------------
// FieldGroup — wraps a label + input + optional hint + optional error
// ---------------------------------------------------------------------------

interface FieldGroupProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}

export function FieldGroup({
  id,
  label,
  hint,
  error,
  required,
  children,
}: FieldGroupProps): React.ReactElement {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  // Provide hint/error ids via context so child inputs can wire aria-describedby
  return (
    <FieldGroupContext.Provider value={{ hintId, errorId }}>
      <div className="space-y-1">
        <label
          htmlFor={id}
          className="block text-sm font-medium text-[var(--color-fg)]"
        >
          {label}
          {required && (
            <span aria-hidden className="ml-1 text-[var(--color-state-error)]">
              *
            </span>
          )}
        </label>
        {children}
        {hint && (
          <p id={hintId} className="text-xs text-[var(--color-fg-muted)]">
            {hint}
          </p>
        )}
        {error && (
          <p
            id={errorId}
            role="alert"
            className="text-xs text-[var(--color-state-error)]"
          >
            {error}
          </p>
        )}
      </div>
    </FieldGroupContext.Provider>
  );
}

export const FieldGroupContext = React.createContext<{
  hintId?: string;
  errorId?: string;
}>({});

// ---------------------------------------------------------------------------
// SaveBar — sticky footer row with Save button + status message
// ---------------------------------------------------------------------------

interface SaveBarProps {
  saving: boolean;
  successMsg: string | null;
  saveError: string | null;
  onSubmit: (e: React.FormEvent) => void;
  updatedAt?: string;
}

export function SaveBar({
  saving,
  successMsg,
  saveError,
  onSubmit,
  updatedAt,
}: SaveBarProps): React.ReactElement {
  return (
    <div className="mt-8 border-t pt-4 space-y-3">
      {saveError && (
        <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {saveError}
        </div>
      )}
      {successMsg && (
        <div role="status" className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          {successMsg}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          form="settings-form"
          onClick={(e) => void onSubmit(e as unknown as React.FormEvent)}
          disabled={saving}
          aria-busy={saving || undefined}
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
            "bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {saving && (
            <span
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
              aria-hidden
            />
          )}
          Save settings
        </button>
        {updatedAt && (
          <p className="text-xs text-[var(--color-fg-muted)]">
            Last updated: {new Date(updatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SelectField — accessible <select> wrapper
// ---------------------------------------------------------------------------

interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

export function SelectField({
  id,
  label,
  hint,
  error,
  children,
  ...props
}: SelectFieldProps): React.ReactElement {
  return (
    <FieldGroup id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={error ? true : undefined}
        className={cn(
          "h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-60",
          "aria-[invalid=true]:border-[var(--color-state-error)]",
        )}
        {...props}
      >
        {children}
      </select>
    </FieldGroup>
  );
}

// ---------------------------------------------------------------------------
// NumberField — accessible <input type="number"> wrapper
// ---------------------------------------------------------------------------

interface NumberFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}

export function NumberField({
  id,
  label,
  hint,
  error,
  ...props
}: NumberFieldProps): React.ReactElement {
  return (
    <FieldGroup id={id} label={label} hint={hint} error={error}>
      <input
        type="number"
        id={id}
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={error ? true : undefined}
        className={cn(
          "h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-60",
          "aria-[invalid=true]:border-[var(--color-state-error)]",
        )}
        {...props}
      />
    </FieldGroup>
  );
}

// ---------------------------------------------------------------------------
// TextField — accessible <input type="text"> wrapper
// ---------------------------------------------------------------------------

interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  type?: "text" | "email" | "url";
}

export function TextField({
  id,
  label,
  hint,
  error,
  type = "text",
  ...props
}: TextFieldProps): React.ReactElement {
  return (
    <FieldGroup id={id} label={label} hint={hint} error={error}>
      <input
        type={type}
        id={id}
        aria-describedby={
          [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={error ? true : undefined}
        className={cn(
          "h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors",
          "placeholder:text-[var(--color-fg-muted)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
          "aria-[invalid=true]:border-[var(--color-state-error)]",
        )}
        {...props}
      />
    </FieldGroup>
  );
}

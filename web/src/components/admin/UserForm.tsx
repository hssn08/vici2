"use client";

// M01 — Admin user create/edit form.
//
// A11y: form fields have explicit <label> elements, aria-required, aria-invalid,
// and aria-describedby for error messages (WCAG 2.2 AA).
// The role selector is a native <select> for accessibility; the multi-select
// pattern from PLAN §6.5 will use this as the base.

import * as React from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserRole = "super_admin" | "admin" | "supervisor" | "agent" | "integrator";

interface FormValues {
  username: string;
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
  active: boolean;
  hotkeysActive: boolean;
  totpRequired: boolean;
}

interface FieldError {
  username?: string;
  email?: string;
  password?: string;
  fullName?: string;
  role?: string;
}

export interface UserFormProps {
  mode: "create";
  onSuccess?: (userId: string) => void;
}

export interface UserEditFormProps {
  mode: "edit";
  initialValues: Omit<FormValues, "password" | "username">;
  userId: string;
  onSuccess?: (userId: string) => void;
}

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "super_admin", label: "Super Admin" },
  { value: "admin", label: "Admin" },
  { value: "supervisor", label: "Supervisor" },
  { value: "agent", label: "Agent" },
  { value: "integrator", label: "Integrator" },
];

// ---------------------------------------------------------------------------
// Field component
// ---------------------------------------------------------------------------

function Field({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className={cn(
          "block text-sm font-medium text-[var(--color-fg)]",
          required && "after:ml-0.5 after:text-[var(--color-state-error)] after:content-['*']",
        )}
      >
        {label}
      </label>
      {React.cloneElement(children as React.ReactElement, {
        id,
        "aria-required": required ?? false,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error ? errorId : undefined,
      })}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-state-error)]">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password strength feedback (simple; not a security gate — server validates)
// ---------------------------------------------------------------------------

function PasswordStrength({ password }: { password: string }): React.ReactElement | null {
  if (!password) return null;
  const hasLength = password.length >= 12;
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const score = [hasLength, hasUpper, hasDigit].filter(Boolean).length;
  const label = score === 3 ? "Strong" : score === 2 ? "Moderate" : "Weak";
  const colour =
    score === 3
      ? "var(--color-state-active)"
      : score === 2
        ? "var(--color-state-hold)"
        : "var(--color-state-error)";
  return (
    <div aria-live="polite" className="mt-1 flex items-center gap-2 text-xs">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-1 w-8 rounded-full"
            style={{
              background: i < score ? colour : "var(--color-surface-border)",
            }}
            aria-hidden
          />
        ))}
      </div>
      <span style={{ color: colour }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

export function UserForm({ onSuccess }: UserFormProps): React.ReactElement {
  const [values, setValues] = React.useState<FormValues>({
    username: "",
    email: "",
    password: "",
    fullName: "",
    role: "agent",
    active: true,
    hotkeysActive: true,
    totpRequired: false,
  });
  const [errors, setErrors] = React.useState<FieldError>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const validate = (): boolean => {
    const errs: FieldError = {};
    if (!values.username || values.username.length < 2) {
      errs.username = "Username must be at least 2 characters";
    } else if (!/^[a-z0-9_.-]+$/.test(values.username)) {
      errs.username = "Only lowercase letters, numbers, _ . - allowed";
    }
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      errs.email = "Invalid email address";
    }
    if (!values.password || values.password.length < 12) {
      errs.password = "Password must be at least 12 characters";
    } else if (!/[A-Z]/.test(values.password)) {
      errs.password = "Password must contain at least one uppercase letter";
    } else if (!/[0-9]/.test(values.password)) {
      errs.password = "Password must contain at least one digit";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const created = await api.post<{ id: string }>("/api/admin/users", {
        username: values.username,
        email: values.email || undefined,
        password: values.password,
        fullName: values.fullName || undefined,
        role: values.role,
        active: values.active,
        hotkeysActive: values.hotkeysActive,
        totpRequired: values.totpRequired,
      });
      onSuccess?.(created.id);
      // Navigate to user edit page
      window.location.href = `/admin/users/${created.id}`;
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === "conflict"
            ? "A user with that username already exists"
            : err.message
          : "Failed to create user";
      setServerError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const set = <K extends keyof FormValues>(key: K, val: FormValues[K]): void => {
    setValues((v) => ({ ...v, [key]: val }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      aria-label="Create user"
    >
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Account details
        </legend>

        <Field id="username" label="Username" required error={errors.username}>
          <Input
            type="text"
            autoComplete="username"
            value={values.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="e.g. jsmith"
          />
        </Field>

        <Field id="email" label="Email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="user@example.com"
          />
        </Field>

        <Field id="fullName" label="Full name" error={errors.fullName}>
          <Input
            type="text"
            autoComplete="name"
            value={values.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            placeholder="Jane Smith"
          />
        </Field>

        <Field id="password" label="Password" required error={errors.password}>
          <Input
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder="Min. 12 chars, 1 uppercase, 1 digit"
          />
        </Field>
        <PasswordStrength password={values.password} />
      </fieldset>

      <fieldset className="mt-6 space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Role &amp; permissions
        </legend>

        <Field id="role" label="Role" required error={errors.role}>
          <select
            id="role"
            value={values.role}
            onChange={(e) => set("role", e.target.value as UserRole)}
            className="h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors"
            aria-required
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.active}
              onChange={(e) => set("active", e.target.checked)}
              className="h-4 w-4 rounded border"
              aria-label="Account active"
            />
            <span className="text-sm text-[var(--color-fg)]">Account active</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.hotkeysActive}
              onChange={(e) => set("hotkeysActive", e.target.checked)}
              className="h-4 w-4 rounded border"
              aria-label="Enable hotkeys"
            />
            <span className="text-sm text-[var(--color-fg)]">Enable hotkeys</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.totpRequired}
              onChange={(e) => set("totpRequired", e.target.checked)}
              className="h-4 w-4 rounded border"
              aria-label="Require TOTP (2FA)"
            />
            <span className="text-sm text-[var(--color-fg)]">Require TOTP (2FA)</span>
          </label>
        </div>
      </fieldset>

      {serverError && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {serverError}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" loading={submitting} aria-label="Create user">
          Create user
        </Button>
        <a
          href="/admin/users"
          className="text-sm text-[var(--color-fg-muted)] hover:underline"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Edit form (subset: no username change, no password)
// ---------------------------------------------------------------------------

export function UserEditForm({
  initialValues,
  userId,
  onSuccess,
}: Omit<UserEditFormProps, "mode">): React.ReactElement {
  const [values, setValues] = React.useState(initialValues);
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setServerError(null);
    setSuccessMsg(null);
    try {
      const updated = await api.patch<{ id: string }>(`/api/admin/users/${userId}`, {
        email: values.email || undefined,
        fullName: values.fullName || undefined,
        role: values.role,
        active: values.active,
        hotkeysActive: values.hotkeysActive,
        totpRequired: values.totpRequired,
      });
      setSuccessMsg("User updated successfully");
      onSuccess?.(updated.id);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to update user";
      setServerError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const set = <K extends keyof typeof values>(key: K, val: (typeof values)[K]): void => {
    setValues((v) => ({ ...v, [key]: val }));
    setSuccessMsg(null);
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      aria-label="Edit user"
    >
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Account details
        </legend>

        <Field id="edit-email" label="Email">
          <Input
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="user@example.com"
          />
        </Field>

        <Field id="edit-fullName" label="Full name">
          <Input
            type="text"
            autoComplete="name"
            value={values.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            placeholder="Jane Smith"
          />
        </Field>
      </fieldset>

      <fieldset className="mt-6 space-y-4">
        <legend className="text-base font-semibold text-[var(--color-fg)]">
          Role &amp; permissions
        </legend>

        <Field id="edit-role" label="Role" required>
          <select
            id="edit-role"
            value={values.role}
            onChange={(e) => set("role", e.target.value as UserRole)}
            className="h-9 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1 text-sm shadow-sm transition-colors"
            aria-required
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.active}
              onChange={(e) => set("active", e.target.checked)}
              className="h-4 w-4 rounded border"
              aria-label="Account active"
            />
            <span className="text-sm text-[var(--color-fg)]">Account active</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.hotkeysActive}
              onChange={(e) => set("hotkeysActive", e.target.checked)}
              className="h-4 w-4 rounded border"
              aria-label="Enable hotkeys"
            />
            <span className="text-sm text-[var(--color-fg)]">Enable hotkeys</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={values.totpRequired}
              onChange={(e) => set("totpRequired", e.target.checked)}
              className="h-4 w-4 rounded border"
              aria-label="Require TOTP (2FA)"
            />
            <span className="text-sm text-[var(--color-fg)]">Require TOTP (2FA)</span>
          </label>
        </div>
      </fieldset>

      {serverError && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {serverError}
        </div>
      )}

      {successMsg && (
        <div role="status" className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
          {successMsg}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" loading={submitting} aria-label="Save changes">
          Save changes
        </Button>
        <a
          href="/admin/users"
          className="text-sm text-[var(--color-fg-muted)] hover:underline"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

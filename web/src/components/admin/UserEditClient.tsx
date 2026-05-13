"use client";

// M01 — Client component that loads a user from the API and renders the edit form.

import * as React from "react";
import { api, ApiError } from "@/lib/api";
import { UserEditForm } from "./UserForm";

interface UserData {
  id: string;
  username: string;
  email: string | null;
  fullName: string | null;
  role: string;
  active: boolean;
  hotkeysActive: boolean;
  totpRequired: boolean;
  lastLoginAt: string | null;
}

export function UserEditClient({ userId }: { userId: string }): React.ReactElement {
  const [user, setUser] = React.useState<UserData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<UserData>(`/api/admin/users/${userId}`)
      .then((data) => {
        if (!cancelled) setUser(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load user");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) {
    return (
      <div role="status" aria-label="Loading user" className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-10 animate-pulse rounded-md bg-[var(--color-surface-muted)]"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!user) return <></>;

  return (
    <>
      {/* Read-only header info */}
      <div className="mb-6 rounded-lg border p-4 bg-[var(--color-surface-muted)]">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-[var(--color-fg-muted)]">Username</dt>
            <dd className="font-medium text-[var(--color-fg)]">{user.username}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-fg-muted)]">Last login</dt>
            <dd className="text-[var(--color-fg)]">
              {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Never"}
            </dd>
          </div>
        </dl>
      </div>

      <UserEditForm
        userId={userId}
        initialValues={{
          email: user.email ?? "",
          fullName: user.fullName ?? "",
          role: user.role as import("./UserForm").UserRole,
          active: user.active,
          hotkeysActive: user.hotkeysActive,
          totpRequired: user.totpRequired,
        }}
      />

      {/* SIP credential rotation — calls F05 endpoint */}
      <div className="mt-8 border-t pt-6">
        <h2 className="text-base font-semibold text-[var(--color-fg)]">SIP credentials</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Generate a new SIP password for this user. The password is shown once only.
        </p>
        <SipRotateButton userId={userId} username={user.username} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// SIP rotate sub-component (calls POST /api/auth/sip/rotate)
// ---------------------------------------------------------------------------

function SipRotateButton({
  userId,
  username,
}: {
  userId: string;
  username: string;
}): React.ReactElement {
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleRotate = async (): Promise<void> => {
    if (
      !window.confirm(
        `Rotate SIP password for "${username}"? The current SIP registration will drop until the device re-registers.`,
      )
    ) {
      return;
    }
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const resp = await api.post<{ sip_password: string }>("/api/auth/sip/rotate", {
        user_id: userId,
      });
      setResult(resp.sip_password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "SIP rotate failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => void handleRotate()}
        disabled={loading}
        aria-busy={loading}
        className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-50"
        aria-label={`Rotate SIP password for ${username}`}
      >
        {loading ? "Rotating…" : "Rotate SIP password"}
      </button>

      {result && (
        <div role="status" className="mt-3 rounded-md border bg-[var(--color-surface-muted)] p-3">
          <p className="text-xs text-[var(--color-fg-muted)]">New SIP password (shown once):</p>
          <code className="mt-1 block font-mono text-sm text-[var(--color-fg)] select-all">
            {result}
          </code>
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            Copy this now — it will not be shown again.
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className="mt-3 text-sm text-[var(--color-state-error)]">
          {error}
        </div>
      )}
    </div>
  );
}

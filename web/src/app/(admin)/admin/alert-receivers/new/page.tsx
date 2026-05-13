// O03 — Admin: create new alert receiver.
// URL: /admin/alert-receivers/new

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "slack" | "pagerduty" | "webhook";

export default function NewAlertReceiverPage(): React.ReactElement {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [routingKey, setRoutingKey] = useState("");
  const [secret, setSecret] = useState("");
  const [severityFilter, setSeverityFilter] = useState("page,warn,info");
  const [active, setActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildConfig = (): Record<string, unknown> => {
    if (kind === "slack") return { url };
    if (kind === "pagerduty") return { routing_key: routingKey };
    return { url, secret: secret || undefined };
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/alert-receivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name,
          config: buildConfig(),
          active,
          severityFilter,
        }),
      });

      if (res.ok) {
        router.push("/admin/alert-receivers");
      } else {
        const body = await res.json().catch(() => ({}));
        setError((body as { message?: string }).message ?? "Failed to create receiver.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="max-w-lg">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">New Alert Receiver</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Configure a destination for alert notifications.
        </p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. ops-slack-oncall"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="kind">
            Kind
          </label>
          <select
            id="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          >
            <option value="slack">Slack</option>
            <option value="pagerduty">PagerDuty</option>
            <option value="webhook">Generic Webhook</option>
          </select>
        </div>

        {kind === "slack" && (
          <div>
            <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="slack-url">
              Slack Webhook URL
            </label>
            <input
              id="slack-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/T.../B.../..."
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
            />
          </div>
        )}

        {kind === "pagerduty" && (
          <div>
            <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="pd-key">
              PagerDuty Integration Key (routing key)
            </label>
            <input
              id="pd-key"
              type="text"
              required
              value={routingKey}
              onChange={(e) => setRoutingKey(e.target.value)}
              placeholder="rk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
            />
          </div>
        )}

        {kind === "webhook" && (
          <>
            <div>
              <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="wh-url">
                Webhook URL
              </label>
              <input
                id="wh-url"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://myapp.example.com/hooks/alerts"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="wh-secret">
                HMAC Secret (optional)
              </label>
              <input
                id="wh-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Leave blank to disable signature"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
              />
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                If set, a HMAC-SHA256 signature is sent in X-Vici2-Signature header.
              </p>
            </div>
          </>
        )}

        <div>
          <label className="block text-sm font-medium text-[var(--color-fg)] mb-1" htmlFor="severity">
            Severity filter
          </label>
          <input
            id="severity"
            type="text"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            placeholder="page,warn,info"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-500)]"
          />
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Comma-separated list of severities to deliver: page, warn, info.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="active"
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-brand-600)]"
          />
          <label className="text-sm text-[var(--color-fg)]" htmlFor="active">
            Active (enable immediately)
          </label>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] disabled:opacity-50 transition-colors"
          >
            {submitting ? "Creating..." : "Create receiver"}
          </button>
          <a
            href="/admin/alert-receivers"
            className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            Cancel
          </a>
        </div>
      </form>
    </main>
  );
}

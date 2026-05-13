'use client';
// W02 — JSON viewer for job.data with redaction highlighting.

import { useState } from 'react';

interface Props {
  queue: string;
  jobId: string;
  data: unknown;
  masked: boolean;
  isSuperAdmin: boolean;
}

const REDACTED = '***REDACTED***';

function highlightRedacted(val: unknown, indent = 0): React.ReactNode {
  if (val === null) return <span className="text-gray-400">null</span>;
  if (val === REDACTED) {
    return (
      <span className="rounded bg-amber-100 px-1 py-0.5 text-xs text-amber-800 font-mono" aria-label="Redacted PII">
        {REDACTED}
      </span>
    );
  }
  if (typeof val === 'string') return <span className="text-green-700 dark:text-green-400">{`"${val}"`}</span>;
  if (typeof val === 'number') return <span className="text-blue-700 dark:text-blue-400">{val}</span>;
  if (typeof val === 'boolean') return <span className="text-purple-700 dark:text-purple-400">{String(val)}</span>;
  if (Array.isArray(val)) {
    if (val.length === 0) return <span>{'[]'}</span>;
    return (
      <span>
        {'[\n'}
        {val.map((item, i) => (
          <span key={i}>
            {' '.repeat((indent + 1) * 2)}
            {highlightRedacted(item, indent + 1)}
            {i < val.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {' '.repeat(indent * 2)}
        {']'}
      </span>
    );
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return <span>{'{}'}</span>;
    return (
      <span>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {' '.repeat((indent + 1) * 2)}
            <span className="text-[var(--color-fg)]">{`"${k}"`}</span>
            {': '}
            {highlightRedacted(v, indent + 1)}
            {i < entries.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {' '.repeat(indent * 2)}
        {'}'}
      </span>
    );
  }
  return <span>{String(val)}</span>;
}

export function JobDataViewer({ queue, jobId, data: initialData, masked: initialMasked, isSuperAdmin }: Props): React.ReactElement {
  const [data, setData] = useState(initialData);
  const [masked, setMasked] = useState(initialMasked);
  const [loading, setLoading] = useState(false);

  async function handleUnmask() {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/jobs/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(jobId)}`,
        {
          credentials: 'include',
          headers: { 'X-Jobs-Unmask': '1' },
        },
      );
      if (res.ok) {
        const d = (await res.json()) as { data: unknown };
        setData(d.data);
        setMasked(false);
        alert('Viewing unmasked job data. This action is audited.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Job Data</h2>
        <div className="flex items-center gap-2">
          {masked && (
            <span className="text-xs text-amber-600 bg-amber-50 rounded px-2 py-0.5">
              PII Masked
            </span>
          )}
          {isSuperAdmin && masked && (
            <button
              onClick={handleUnmask}
              disabled={loading}
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
              title="View unmasked data (audited)"
            >
              {loading ? 'Loading…' : 'Unmask'}
            </button>
          )}
        </div>
      </div>
      <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] p-3 text-xs font-mono leading-relaxed">
        <code>{highlightRedacted(data)}</code>
      </pre>
    </div>
  );
}

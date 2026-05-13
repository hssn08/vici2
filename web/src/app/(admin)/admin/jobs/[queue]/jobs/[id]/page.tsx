// W02 — Job detail page (Server Component).
//
// URL: /admin/jobs/[queue]/jobs/[id]

import { cookies } from 'next/headers';
import Link from 'next/link';
import { JobActionsCard } from './_components/JobActionsCard';
import { JobDataViewer } from './_components/JobDataViewer';

export async function generateMetadata({ params }: { params: { queue: string; id: string } }) {
  return { title: `Job ${params.id.slice(0, 8)}… · vici2 Admin` };
}

async function fetchJobDetail(queue: string, id: string) {
  const cookieStore = cookies();
  const token = cookieStore.get('sx_token')?.value ?? '';
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const res = await fetch(
    `${base}/api/admin/jobs/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!res.ok) return null;
  return res.json() as Promise<{
    id: string; name: string; queue: string; state: string;
    attemptsMade: number; maxAttempts: number; timestamp: number;
    processedOn: number | null; finishedOn: number | null;
    delay: number; priority: number; failedReason: string | null;
    stacktrace: string[]; opts: Record<string, unknown>;
    data: unknown; returnvalue: unknown;
    logs: string[];
    _dataTruncated: boolean; _returnvalueTruncated: boolean; _masked: boolean;
  }>;
}

const STATE_BADGE: Record<string, string> = {
  failed:    'bg-red-100 text-red-800',
  waiting:   'bg-sky-100 text-sky-800',
  active:    'bg-green-100 text-green-800',
  completed: 'bg-gray-100 text-gray-700',
  delayed:   'bg-yellow-100 text-yellow-800',
};

export default async function JobDetailPage({
  params,
}: {
  params: { queue: string; id: string };
}): Promise<React.ReactElement> {
  const job = await fetchJobDetail(params.queue, params.id);

  if (!job) {
    return (
      <main>
        <p className="text-[var(--color-fg-muted)]">Job not found.</p>
        <Link href={`/admin/jobs/${params.queue}`} className="text-sm text-blue-600 hover:underline">
          Back to queue
        </Link>
      </main>
    );
  }

  const badgeClass = STATE_BADGE[job.state] ?? 'bg-gray-100 text-gray-700';

  return (
    <main>
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-[var(--color-fg-muted)]" aria-label="Breadcrumb">
        <Link href="/admin/jobs" className="hover:underline">Job Queues</Link>
        <span className="mx-1">/</span>
        <Link href={`/admin/jobs/${params.queue}`} className="hover:underline">{params.queue}</Link>
        <span className="mx-1">/</span>
        <span className="font-mono">{job.id.slice(0, 12)}…</span>
      </nav>

      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-semibold font-mono text-[var(--color-fg)]">{job.id}</h1>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${badgeClass}`}>
          {job.state}
        </span>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-6">
        {/* Metadata card */}
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-fg)] mb-3">Metadata</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {[
              ['Name', job.name],
              ['Attempts', `${job.attemptsMade} / ${job.maxAttempts}`],
              ['Priority', String(job.priority)],
              ['Delay', job.delay ? `${job.delay}ms` : 'none'],
              ['Enqueued', new Date(job.timestamp).toLocaleString()],
              ['Processed', job.processedOn ? new Date(job.processedOn).toLocaleString() : '—'],
              ['Finished', job.finishedOn ? new Date(job.finishedOn).toLocaleString() : '—'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-[var(--color-fg-muted)]">{label}</dt>
                <dd className="font-medium text-[var(--color-fg)]">{value}</dd>
              </div>
            ))}
          </dl>
          {job.failedReason && (
            <div className="mt-3">
              <dt className="text-xs text-[var(--color-fg-muted)]">Failed Reason</dt>
              <dd className="mt-1 rounded bg-red-50 p-2 text-xs text-red-700 font-mono">{job.failedReason}</dd>
            </div>
          )}
        </div>

        {/* Actions card */}
        <JobActionsCard
          queue={params.queue}
          jobId={job.id}
          state={job.state}
          isSuperAdmin={false}
        />
      </div>

      {/* Job Data */}
      <div className="mb-4">
        <JobDataViewer
          queue={params.queue}
          jobId={job.id}
          data={job.data}
          masked={job._masked}
          isSuperAdmin={false}
        />
      </div>

      {/* Stacktrace */}
      {job.stacktrace && job.stacktrace.length > 0 && (
        <details className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[var(--color-fg)]">
            Stacktrace ({job.stacktrace.length} attempt{job.stacktrace.length !== 1 ? 's' : ''})
          </summary>
          <div className="divide-y divide-[var(--color-border)]">
            {job.stacktrace.map((trace, i) => (
              <div key={i} className="p-4">
                <p className="mb-1 text-xs font-medium text-[var(--color-fg-muted)]">Attempt {i + 1}</p>
                <pre className="overflow-x-auto text-xs text-red-600 font-mono">{trace}</pre>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Logs */}
      {job.logs && job.logs.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Logs</h2>
          <ul className="space-y-1">
            {job.logs.map((log, i) => (
              <li key={i} className="text-xs font-mono text-[var(--color-fg)]">{log}</li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

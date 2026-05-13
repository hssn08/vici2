// W02 — Queue detail page (Server Component).
//
// URL: /admin/jobs/[queue]
// Shows job list by state (tabs) + pause/resume/drain actions.

import { cookies } from 'next/headers';
import Link from 'next/link';
import { PauseResumeButton } from './_components/PauseResumeButton';
import { DrainQueueDialog } from './_components/DrainQueueDialog';

export async function generateMetadata({ params }: { params: { queue: string } }) {
  return { title: `Queue: ${params.queue} · vici2 Admin` };
}

async function fetchQueue(queue: string) {
  const cookieStore = cookies();
  const token = cookieStore.get('sx_token')?.value ?? '';
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const res = await fetch(`${base}/api/admin/jobs/queues`, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 5 },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { queues: Array<{ name: string; displayName: string; kind: string; isPaused: boolean | null; counts: Record<string, number | null>; dlqDepth: number }> };
  const shortName = queue;
  return data.queues.find((q) => q.name.endsWith(':' + shortName) || q.name === shortName) ?? null;
}

async function fetchJobs(queue: string, state: string, page: number) {
  const cookieStore = cookies();
  const token = cookieStore.get('sx_token')?.value ?? '';
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const res = await fetch(
    `${base}/api/admin/jobs/queues/${encodeURIComponent(queue)}/jobs?state=${state}&page=${page}&pageSize=20`,
    { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 5 } },
  );
  if (!res.ok) return { jobs: [], total: 0 };
  return res.json() as Promise<{
    jobs: Array<{
      id: string; name: string; attemptsMade: number; maxAttempts: number;
      timestamp: number; processedOn: number | null; finishedOn: number | null;
      failedReason: string | null;
    }>;
    total: number;
  }>;
}

const JOB_STATES = ['failed', 'waiting', 'active', 'completed', 'delayed'] as const;

export default async function QueueDetailPage({
  params,
  searchParams,
}: {
  params: { queue: string };
  searchParams?: { state?: string; page?: string };
}): Promise<React.ReactElement> {
  const state = (searchParams?.state ?? 'failed') as string;
  const page = Math.max(0, parseInt(searchParams?.page ?? '0', 10));

  const [queueMeta, jobsData] = await Promise.all([
    fetchQueue(params.queue),
    fetchJobs(params.queue, state, page),
  ]);

  if (!queueMeta) {
    return (
      <main>
        <p className="text-[var(--color-fg-muted)]">Queue not found: {params.queue}</p>
        <Link href="/admin/jobs" className="text-sm text-blue-600 hover:underline">
          Back to queues
        </Link>
      </main>
    );
  }

  const isBullmq = queueMeta.kind === 'bullmq';

  return (
    <main>
      {/* Header */}
      <div className="mb-6">
        <nav className="mb-2 text-sm text-[var(--color-fg-muted)]" aria-label="Breadcrumb">
          <Link href="/admin/jobs" className="hover:underline">Job Queues</Link>
          <span className="mx-1">/</span>
          <span>{queueMeta.displayName}</span>
        </nav>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--color-fg)]">{queueMeta.displayName}</h1>
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)] font-mono">{queueMeta.name}</p>
          </div>
          <div className="flex items-center gap-2">
            {isBullmq && (
              <PauseResumeButton queue={params.queue} initialPaused={queueMeta.isPaused ?? false} />
            )}
            {isBullmq && (
              <DrainQueueDialog queue={params.queue} displayName={queueMeta.displayName} />
            )}
            {queueMeta.dlqDepth > 0 && (
              <Link
                href={`/admin/jobs/dlq/${params.queue}`}
                className="inline-flex items-center rounded-full bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                View DLQ ({queueMeta.dlqDepth})
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* BullMQ: job tabs + table */}
      {isBullmq && (
        <>
          {/* State tabs */}
          <div className="mb-4 border-b border-[var(--color-border)]" role="tablist">
            {JOB_STATES.map((s) => (
              <Link
                key={s}
                href={`/admin/jobs/${params.queue}?state=${s}`}
                role="tab"
                aria-selected={state === s}
                className={`inline-block border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  state === s
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
                {s === 'failed' && queueMeta.counts.failed != null && queueMeta.counts.failed > 0 && (
                  <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                    {queueMeta.counts.failed}
                  </span>
                )}
              </Link>
            ))}
          </div>

          {/* Job table */}
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-surface-muted)]">
                <tr>
                  {['Job ID', 'Name', 'Attempts', 'Enqueued', 'Processed', 'Finished', 'Failed Reason'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold text-[var(--color-fg-muted)]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {jobsData.jobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-fg-muted)]">
                      No {state} jobs.
                    </td>
                  </tr>
                ) : (
                  jobsData.jobs.map((job) => (
                    <tr
                      key={job.id}
                      className="hover:bg-[var(--color-surface-muted)] cursor-pointer"
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/admin/jobs/${params.queue}/jobs/${job.id}`} className="hover:underline text-blue-600">
                          {job.id.slice(0, 12)}…
                        </Link>
                      </td>
                      <td className="px-3 py-2">{job.name}</td>
                      <td className="px-3 py-2 text-center">{job.attemptsMade}/{job.maxAttempts}</td>
                      <td className="px-3 py-2 text-xs">{new Date(job.timestamp).toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs">{job.processedOn ? new Date(job.processedOn).toLocaleString() : '—'}</td>
                      <td className="px-3 py-2 text-xs">{job.finishedOn ? new Date(job.finishedOn).toLocaleString() : '—'}</td>
                      <td className="px-3 py-2 text-xs text-red-600 max-w-xs truncate" title={job.failedReason ?? ''}>
                        {job.failedReason ? job.failedReason.slice(0, 80) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {jobsData.total > 20 && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-[var(--color-fg-muted)]">
                Showing {page * 20 + 1}–{Math.min((page + 1) * 20, jobsData.total)} of {jobsData.total}
              </span>
              <div className="flex gap-2">
                {page > 0 && (
                  <Link href={`/admin/jobs/${params.queue}?state=${state}&page=${page - 1}`}
                    className="rounded border px-3 py-1 hover:bg-[var(--color-surface-muted)]">
                    Previous
                  </Link>
                )}
                {(page + 1) * 20 < jobsData.total && (
                  <Link href={`/admin/jobs/${params.queue}?state=${state}&page=${page + 1}`}
                    className="rounded border px-3 py-1 hover:bg-[var(--color-surface-muted)]">
                    Next
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Stream/tick queue: read-only stats */}
      {!isBullmq && (
        <div className="rounded-lg border border-[var(--color-border)] p-6">
          <h2 className="text-sm font-semibold text-[var(--color-fg)] mb-3">Queue Statistics (read-only)</h2>
          <dl className="grid grid-cols-2 gap-4">
            {Object.entries(queueMeta.counts).filter(([, v]) => v !== null).map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-[var(--color-fg-muted)] capitalize">{key.replace(/([A-Z])/g, ' $1')}</dt>
                <dd className="text-lg font-semibold text-[var(--color-fg)]">{String(value)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-[var(--color-fg-muted)]">
            Pause/resume is not available for {queueMeta.kind} queues.
          </p>
        </div>
      )}
    </main>
  );
}

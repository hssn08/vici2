// W02 — Jobs queue index page (Server Component).
//
// URL: /admin/jobs
// Permission: jobs:view

import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { QueueIndexLive } from './_components/QueueIndexLive';

export const metadata = { title: 'Job Queues · vici2 Admin' };

// Fetch queue summaries server-side (RSC).
async function fetchQueues() {
  try {
    const cookieStore = cookies();
    const token = cookieStore.get('sx_token')?.value ?? '';
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/admin/jobs/queues`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        next: { revalidate: 5 },
      },
    );
    if (!res.ok) return { queues: [], fetchedAt: new Date().toISOString() };
    return res.json() as Promise<{ queues: unknown[]; fetchedAt: string }>;
  } catch {
    return { queues: [], fetchedAt: new Date().toISOString() };
  }
}

export default async function JobsQueueIndexPage(): Promise<React.ReactElement> {
  const data = await fetchQueues();

  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Job Queues</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Live state of all BullMQ, stream, and tick queues. Counts refresh every 5s.
          </p>
        </div>
        <nav className="flex gap-2" aria-label="Jobs sub-navigation">
          <a
            href="/admin/jobs"
            className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] transition-colors"
          >
            All Queues
          </a>
        </nav>
      </div>

      <Suspense
        fallback={
          <div role="status" aria-label="Loading queues" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-lg bg-[var(--color-surface-muted)]"
                aria-hidden
              />
            ))}
          </div>
        }
      >
        <QueueIndexLive
          initialQueues={data.queues as Parameters<typeof QueueIndexLive>[0]['initialQueues']}
          tenantId={1}
        />
      </Suspense>

      <p className="mt-4 text-xs text-[var(--color-fg-muted)]">
        Last fetched: {data.fetchedAt}
      </p>
    </main>
  );
}

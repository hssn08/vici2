// W02 — DLQ inspect page (Server Component).
//
// URL: /admin/jobs/dlq/[queue]

import { cookies } from 'next/headers';
import Link from 'next/link';
import { DlqEntryTable } from './_components/DlqEntryTable';
import { DlqDrainDialog } from './_components/DlqDrainDialog';

export async function generateMetadata({ params }: { params: { queue: string } }) {
  return { title: `DLQ: ${params.queue} · vici2 Admin` };
}

async function fetchDlqEntries(queue: string) {
  const cookieStore = cookies();
  const token = cookieStore.get('sx_token')?.value ?? '';
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const res = await fetch(
    `${base}/api/admin/jobs/dlq/${encodeURIComponent(queue)}?order=desc&count=20`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!res.ok) return { entries: [], total: 0, nextCursor: null, streamName: '', queue };
  return res.json() as Promise<{
    entries: Array<{
      entryId: string; ts: number; worker: string; sourceQueue: string;
      sourceId: string; payload: Record<string, unknown>; error: string;
      errorStack: string; attempt: number; workerId: string; tenantId: string;
      _masked: boolean;
    }>;
    total: number;
    nextCursor: string | null;
    streamName: string;
    queue: string;
  }>;
}

export default async function DlqInspectPage({
  params,
}: {
  params: { queue: string };
}): Promise<React.ReactElement> {
  const data = await fetchDlqEntries(params.queue);

  return (
    <main>
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-[var(--color-fg-muted)]" aria-label="Breadcrumb">
        <Link href="/admin/jobs" className="hover:underline">Job Queues</Link>
        <span className="mx-1">/</span>
        <Link href={`/admin/jobs/${params.queue}`} className="hover:underline">{params.queue}</Link>
        <span className="mx-1">/</span>
        <span>DLQ</span>
      </nav>

      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">
            DLQ: {params.queue}
          </h1>
          <p className="mt-0.5 text-sm text-[var(--color-fg-muted)] font-mono">{data.streamName}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-red-100 px-3 py-1 text-sm font-semibold text-red-700">
            {data.total} entries
          </span>
          {/* Drain button — only for users with jobs:drain permission */}
          {data.total > 0 && <DlqDrainDialog queue={params.queue} />}
        </div>
      </div>

      {/* Warning callout */}
      <div role="note" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-800">
          Dead-letter queue entries represent jobs that failed all retry attempts.
        </p>
        <p className="mt-1 text-sm text-amber-700">
          Retrying an entry creates a new BullMQ job and removes the entry permanently from this stream.
          This is a two-step operation (Queue.add + XDEL) and is not transactional.
        </p>
      </div>

      {/* DLQ entry table */}
      <DlqEntryTable
        queue={params.queue}
        initialEntries={data.entries}
        total={data.total}
        nextCursor={data.nextCursor}
        streamName={data.streamName}
      />
    </main>
  );
}

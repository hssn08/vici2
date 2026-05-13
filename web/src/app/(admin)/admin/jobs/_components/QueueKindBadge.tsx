'use client';
// W02 — Badge showing BullMQ / Stream / Tick queue kind.

import { cn } from '@/lib/utils';

type Kind = 'bullmq' | 'stream' | 'tick';

const KIND_STYLES: Record<Kind, string> = {
  bullmq: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  stream: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  tick:   'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

const KIND_LABELS: Record<Kind, string> = {
  bullmq: 'BullMQ',
  stream: 'Stream',
  tick:   'Tick',
};

interface Props {
  kind: Kind;
}

export function QueueKindBadge({ kind }: Props): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold',
        KIND_STYLES[kind],
      )}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

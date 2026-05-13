'use client';
// W02 — Colored pill showing a queue state count.

import { cn } from '@/lib/utils';

type State = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';

const STATE_STYLES: Record<State, string> = {
  waiting:   'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  active:    'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  completed: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  failed:    'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  delayed:   'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  paused:    'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

interface Props {
  state: State;
  count: number | null;
}

export function QueueStatePill({ state, count }: Props): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATE_STYLES[state],
      )}
      title={state}
    >
      {state.charAt(0).toUpperCase() + state.slice(1)}: {count ?? '—'}
    </span>
  );
}

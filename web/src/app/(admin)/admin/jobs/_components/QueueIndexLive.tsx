'use client';
// W02 — Live queue index: WS subscription + 5-second polling fallback.

import { useEffect, useRef, useState } from 'react';
import { QueueCard } from './QueueCard';

interface QueueCounts {
  waiting: number | null;
  active: number | null;
  completed: number | null;
  failed: number | null;
  delayed: number | null;
  paused: number | null;
  depth: number | null;
  pending: number | null;
  lockHeld: boolean | null;
  lockHolder: string | null;
  lockTtlMs: number | null;
}

interface QueueSummary {
  name: string;
  displayName: string;
  kind: 'bullmq' | 'stream' | 'tick';
  owner: string;
  isPaused: boolean | null;
  counts: QueueCounts;
  dlqDepth: number;
  warning?: string;
}

interface Props {
  initialQueues: QueueSummary[];
  tenantId: number;
}

export function QueueIndexLive({ initialQueues, tenantId }: Props): React.ReactElement {
  const [queues, setQueues] = useState<QueueSummary[]>(initialQueues);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchQueues() {
    try {
      const res = await fetch('/api/admin/jobs/queues', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { queues: QueueSummary[] };
        setQueues(data.queues);
      }
    } catch {
      // non-fatal
    }
  }

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(fetchQueues, 5_000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    // Attempt WebSocket connection to the API WS endpoint.
    // The API broadcasts on topic t:{tenantId}:bullmq:counts.
    // If WS is unavailable, fall back to polling.
    let ws: WebSocket | null = null;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/api/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        stopPolling();
        // Subscribe to queue count events for this tenant
        ws?.send(JSON.stringify({ type: 'subscribe', topic: `t:${tenantId}:bullmq:counts` }));
      };

      ws.onmessage = () => {
        // Invalidate → trigger background refetch
        void fetchQueues();
      };

      ws.onclose = () => {
        setWsConnected(false);
        startPolling();
      };

      ws.onerror = () => {
        setWsConnected(false);
        startPolling();
      };
    } catch {
      startPolling();
    }

    // If WS doesn't open within 3s, start polling
    const fallbackTimer = setTimeout(() => {
      if (!wsConnected) startPolling();
    }, 3_000);

    return () => {
      clearTimeout(fallbackTimer);
      stopPolling();
      ws?.close();
    };
  }, [tenantId]);

  return (
    <div>
      {!wsConnected && (
        <p className="mb-3 text-xs text-[var(--color-fg-muted)]" aria-live="polite">
          Polling every 5s (WebSocket unavailable)
        </p>
      )}
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        aria-label="Queue status grid"
      >
        {queues.map((q) => (
          <QueueCard key={q.name} queue={q} />
        ))}
      </div>
    </div>
  );
}

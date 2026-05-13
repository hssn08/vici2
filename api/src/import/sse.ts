// D02 — Fastify SSE helper (PLAN §11)
// Heartbeat every 15s prevents NGINX proxy buffer timeout.

import type { FastifyReply } from "fastify";

const HEARTBEAT_INTERVAL_MS = 15_000;

export function setupSseHeaders(reply: FastifyReply): void {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("X-Accel-Buffering", "no");  // Disable NGINX proxy buffering
  reply.raw.setHeader("Connection", "keep-alive");
  // Disable compression for SSE (chunked transfer is sufficient)
  reply.raw.setHeader("Content-Encoding", "identity");
}

export function writeSseEvent(
  reply: FastifyReply,
  event: string,
  data: unknown,
  id?: string,
): void {
  const payload = [
    id ? `id: ${id}` : "",
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
    "",
    "",
  ].filter((line, i) => i !== 0 || id).join("\n");

  reply.raw.write(payload.startsWith("\n") ? payload.slice(1) : payload);
}

export function writeSseHeartbeat(reply: FastifyReply): void {
  reply.raw.write(": heartbeat\n\n");
}

/** Start heartbeat interval. Returns cleanup function. */
export function startHeartbeat(reply: FastifyReply): () => void {
  const timer = setInterval(() => {
    if (reply.raw.destroyed) {
      clearInterval(timer);
      return;
    }
    writeSseHeartbeat(reply);
  }, HEARTBEAT_INTERVAL_MS);

  return () => clearInterval(timer);
}

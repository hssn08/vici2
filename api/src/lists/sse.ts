// D07 — SSE progress stream for async list operations (reset/purge).
//
// Polls Valkey every 500ms and streams data: lines until done or failed.
// Timeout: 10 minutes.

import type { FastifyRequest, FastifyReply } from "fastify";
import { getJobProgress } from "./jobs.js";

const POLL_INTERVAL_MS = 500;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export async function streamJobProgress(
  _req: FastifyRequest,
  reply: FastifyReply,
  jobId: string,
): Promise<void> {
  const raw = reply.raw;
  raw.setHeader("Content-Type", "text/event-stream");
  raw.setHeader("Cache-Control", "no-cache");
  raw.setHeader("Connection", "keep-alive");
  raw.setHeader("X-Accel-Buffering", "no");
  raw.flushHeaders();

  const deadline = Date.now() + MAX_DURATION_MS;

  const poll = async (): Promise<void> => {
    if (Date.now() > deadline) {
      raw.write("data: {\"status\":\"timeout\"}\n\n");
      raw.end();
      return;
    }

    const progress = await getJobProgress(jobId);
    if (!progress) {
      raw.write("data: {\"status\":\"not_found\"}\n\n");
      raw.end();
      return;
    }

    raw.write(`data: ${JSON.stringify(progress)}\n\n`);

    if (progress.status === "done" || progress.status === "failed") {
      raw.end();
      return;
    }

    setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
  };

  await poll();
}

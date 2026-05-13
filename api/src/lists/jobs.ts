// D07 — BullMQ job definitions and enqueue helpers.
//
// Queue: "list-ops"
// Processes: reset (bulk UPDATE leads to NEW) and purge (soft-delete leads).

import { Queue } from "bullmq";
import { getRedis } from "../lib/redis.js";

export const LIST_OPS_QUEUE = "list-ops";

export interface ListResetJobData {
  type: "reset";
  tenantId: number;
  listId: number;
  actorUserId: number;
  requestId: string;
  batchSize: number;
}

export interface ListPurgeJobData {
  type: "purge";
  tenantId: number;
  listId: number;
  actorUserId: number;
  requestId: string;
  batchSize: number;
}

export type ListOpJobData = ListResetJobData | ListPurgeJobData;

export interface JobProgress {
  status: "pending" | "running" | "done" | "failed";
  processed: number;
  total: number;
  pct: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

function progressKey(jobId: string): string {
  return `list:job:${jobId}:progress`;
}

const JOB_PROGRESS_TTL = 3600; // 1 hour

let _queue: Queue<ListOpJobData> | null = null;

export function getListOpsQueue(): Queue<ListOpJobData> {
  if (!_queue) {
    const redis = getRedis();
    _queue = new Queue<ListOpJobData>(LIST_OPS_QUEUE, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });
  }
  return _queue;
}

export async function enqueueListReset(data: Omit<ListResetJobData, "type">): Promise<string> {
  const queue = getListOpsQueue();
  const job = await queue.add("reset", { type: "reset", ...data });
  const jobId = String(job.id);

  // Initialize progress in Valkey
  const redis = getRedis();
  const progress: JobProgress = {
    status: "pending",
    processed: 0,
    total: 0,
    pct: 0,
    started_at: null,
    finished_at: null,
    error: null,
  };
  await redis.set(progressKey(jobId), JSON.stringify(progress), "EX", JOB_PROGRESS_TTL);

  return jobId;
}

export async function enqueueListPurge(data: Omit<ListPurgeJobData, "type">): Promise<string> {
  const queue = getListOpsQueue();
  const job = await queue.add("purge", { type: "purge", ...data });
  const jobId = String(job.id);

  const redis = getRedis();
  const progress: JobProgress = {
    status: "pending",
    processed: 0,
    total: 0,
    pct: 0,
    started_at: null,
    finished_at: null,
    error: null,
  };
  await redis.set(progressKey(jobId), JSON.stringify(progress), "EX", JOB_PROGRESS_TTL);

  return jobId;
}

export async function getJobProgress(jobId: string): Promise<JobProgress | null> {
  const redis = getRedis();
  const raw = await redis.get(progressKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw) as JobProgress;
}

export async function setJobProgress(jobId: string, progress: JobProgress): Promise<void> {
  const redis = getRedis();
  await redis.set(progressKey(jobId), JSON.stringify(progress), "EX", JOB_PROGRESS_TTL);
}

export function closeQueue(): Promise<void> {
  if (_queue) {
    const q = _queue;
    _queue = null;
    return q.close();
  }
  return Promise.resolve();
}

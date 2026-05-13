// N03 — BullMQ write-back worker for reliable SF Task creation.
//
// Queue: vici2:queue:sf-writeback
// Retry: 3× exponential back-off (2s, 4s, 8s)
// DLQ: records error in sf_integrations.last_error

import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import client from 'prom-client';

import { getRedis } from '../lib/redis.js';
import { getPrisma } from '../lib/prisma.js';
import { getAccessToken } from '../routes/adapters/sf-integration/token-store.js';
import { mapDispoToSfTask, type DispoCommitPayload, type SfTaskPayload } from '../routes/adapters/sf-integration/task-mapper.js';
import { SfFieldMappingsSchema } from '../routes/adapters/sf-integration/schema.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'n03-worker' } });

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

const sfWritebackTotal = new client.Counter({
  name: 'vici2_sf_writeback_total',
  help: 'SF Task write-back attempts',
  labelNames: ['tenant_id', 'result'] as const,
});

const sfWritebackDuration = new client.Histogram({
  name: 'vici2_sf_writeback_duration_seconds',
  help: 'SF REST API call duration',
  labelNames: ['tenant_id'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 15, 30],
});

const sfTokenRefreshTotal = new client.Counter({
  name: 'vici2_sf_token_refresh_total',
  help: 'OAuth token refresh attempts',
  labelNames: ['tenant_id', 'result'] as const,
});

// ---------------------------------------------------------------------------
// Job payload type
// ---------------------------------------------------------------------------

export interface SfWritebackJob {
  tenantId: number;
  payload: DispoCommitPayload;
}

// ---------------------------------------------------------------------------
// HTTP client interface (injectable for testing)
// ---------------------------------------------------------------------------

export interface SfRestClient {
  createTask(token: string, instanceUrl: string, task: SfTaskPayload): Promise<{ id?: string; error?: string }>;
  updateTask(token: string, instanceUrl: string, taskId: string, task: SfTaskPayload): Promise<void>;
  findTaskByCallId(token: string, instanceUrl: string, callId: string): Promise<string | null>;
}

export const defaultSfRestClient: SfRestClient = {
  async createTask(token, instanceUrl, task) {
    const res = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Task`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(task),
    });
    if (!res.ok) {
      throw new Error(`SF Task create failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{ id?: string }>;
  },

  async updateTask(token, instanceUrl, taskId, task) {
    const res = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Task/${taskId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(task),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`SF Task update failed: ${res.status} ${await res.text()}`);
    }
  },

  async findTaskByCallId(token, instanceUrl, callId) {
    // Phase 1: SOQL query on Description prefix (Phase 2: Vici2_Call_Id__c custom field)
    const soql = encodeURIComponent(
      `SELECT Id FROM Task WHERE Description LIKE '[vici2:callId:${callId}]%' LIMIT 1`,
    );
    const res = await fetch(`${instanceUrl}/services/data/v58.0/query?q=${soql}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { records?: Array<{ Id: string }> };
    return data.records?.[0]?.Id ?? null;
  },
};

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function startSfWritebackWorker(sfClient: SfRestClient = defaultSfRestClient): Worker<SfWritebackJob> {
  const worker = new Worker<SfWritebackJob>(
    'vici2:queue:sf-writeback',
    async (job: Job<SfWritebackJob>) => {
      const { tenantId, payload } = job.data;
      const tenantIdBigInt = BigInt(tenantId);
      const tenantLabel = String(tenantId);
      const db = getPrisma();

      // 1. Get integration config
      const integration = await db.sfIntegration.findUnique({
        where: { tenantId: tenantIdBigInt },
      });
      if (!integration || !integration.enabled) {
        logger.info({ tenantId, callId: payload.callId }, 'SF integration disabled, skipping write-back');
        return;
      }

      // 2. Get access token (auto-refresh)
      let token: string;
      let instanceUrl: string;
      try {
        const result = await getAccessToken(tenantIdBigInt);
        token = result.token;
        instanceUrl = result.instanceUrl;
        sfTokenRefreshTotal.labels(tenantLabel, 'ok').inc();
      } catch (err) {
        sfTokenRefreshTotal.labels(tenantLabel, 'error').inc();
        throw err;
      }

      // 3. Map dispo to SF Task fields
      const fieldMappings = SfFieldMappingsSchema.parse(integration.fieldMappings ?? {});
      const taskPayload = mapDispoToSfTask(payload, fieldMappings);

      // 4. Dedup check (SOQL)
      const startTime = Date.now();
      try {
        const existingTaskId = await sfClient.findTaskByCallId(token, instanceUrl, payload.callId);

        if (existingTaskId) {
          await sfClient.updateTask(token, instanceUrl, existingTaskId, taskPayload);
          logger.info({ tenantId, callId: payload.callId, taskId: existingTaskId }, 'SF Task updated');
        } else {
          const result = await sfClient.createTask(token, instanceUrl, taskPayload);
          logger.info({ tenantId, callId: payload.callId, taskId: result.id }, 'SF Task created');
        }

        sfWritebackTotal.labels(tenantLabel, 'success').inc();
        sfWritebackDuration.labels(tenantLabel).observe((Date.now() - startTime) / 1000);

        // 5. Update last_writeback_at
        await db.sfIntegration.update({
          where: { tenantId: tenantIdBigInt },
          data: { lastWritebackAt: new Date(), lastError: null },
        });
      } catch (err) {
        sfWritebackTotal.labels(tenantLabel, 'failure').inc();
        sfWritebackDuration.labels(tenantLabel).observe((Date.now() - startTime) / 1000);
        throw err;
      }
    },
    {
      connection: getRedis(),
      concurrency: 5,
    },
  );

  // On final failure (all retries exhausted), record error in DB
  worker.on('failed', async (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? 3;
    if (job.attemptsMade < maxAttempts) return; // not final failure yet

    const { tenantId } = job.data;
    logger.error({ tenantId, callId: job.data.payload.callId, err }, 'SF write-back final failure');

    try {
      const db = getPrisma();
      await db.sfIntegration.update({
        where: { tenantId: BigInt(tenantId) },
        data: { lastError: err.message.slice(0, 500) },
      });
    } catch (dbErr) {
      logger.error({ dbErr }, 'Failed to record SF write-back error in DB');
    }
  });

  return worker;
}

// ---------------------------------------------------------------------------
// Queue helper: enqueue a write-back job
// ---------------------------------------------------------------------------

export async function enqueueSfWriteback(
  tenantId: number,
  payload: DispoCommitPayload,
): Promise<void> {
  const { Queue } = await import('bullmq');
  const queue = new Queue<SfWritebackJob>('vici2:queue:sf-writeback', {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });
  await queue.add('writeback', { tenantId, payload });
  await queue.close();
}

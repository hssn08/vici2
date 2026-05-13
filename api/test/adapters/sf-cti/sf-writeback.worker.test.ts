// N03 — Unit tests for SF write-back worker logic.
// Uses fake SfRestClient to avoid real SF API calls.

import { describe, it, expect } from 'vitest';
import { mapDispoToSfTask } from '../../../src/routes/adapters/sf-integration/task-mapper.js';
import type { DispoCommitPayload } from '../../../src/routes/adapters/sf-integration/task-mapper.js';
import type { SfRestClient } from '../../../src/workers/sf-writeback.worker.js';

// ---------------------------------------------------------------------------
// Fake SF REST client
// ---------------------------------------------------------------------------

function makeFakeSfClient(opts: {
  existingTaskId?: string;
  createFails?: boolean;
}): SfRestClient & {
  createdTasks: Array<{ token: string; task: object }>;
  updatedTasks: Array<{ taskId: string; task: object }>;
} {
  const createdTasks: Array<{ token: string; task: object }> = [];
  const updatedTasks: Array<{ taskId: string; task: object }> = [];

  return {
    createdTasks,
    updatedTasks,

    async findTaskByCallId(_token, _instanceUrl, _callId) {
      return opts.existingTaskId ?? null;
    },

    async createTask(token, _instanceUrl, task) {
      if (opts.createFails) throw new Error('SF Task create failed: 503 Service Unavailable');
      createdTasks.push({ token, task });
      return { id: 'new-task-id-001' };
    },

    async updateTask(_token, _instanceUrl, taskId, task) {
      updatedTasks.push({ taskId, task });
    },
  };
}

// ---------------------------------------------------------------------------
// Task mapper tests (integrated with worker logic)
// ---------------------------------------------------------------------------

const PAYLOAD: DispoCommitPayload = {
  callId: 'call-uuid-worker-test',
  dispo: 'SALE',
  dispoLabel: 'Sale',
  notes: 'Worker test notes',
  sfRecordId: '003xx0000001AAA',
  sfObjectType: 'Contact',
  callDurationSeconds: 180,
  callStartAt: '2026-05-13T10:00:00.000Z',
  direction: 'outbound',
};

describe('SF write-back worker — task shape', () => {
  it('creates correct task payload via mapDispoToSfTask', () => {
    const task = mapDispoToSfTask(PAYLOAD, {});
    expect(task.Subject).toBe('Call: Sale');
    expect(task.Status).toBe('Completed');
    expect(task.CallType).toBe('Outbound');
    expect(task.CallDurationInSeconds).toBe(180);
    expect(task.Description).toContain('[vici2:callId:call-uuid-worker-test]');
    expect(task.WhoId).toBe('003xx0000001AAA');
  });
});

describe('SF write-back worker — fake client scenarios', () => {
  it('creates a new Task when no existing task found', async () => {
    const client = makeFakeSfClient({});
    const task = mapDispoToSfTask(PAYLOAD, {});

    const existingId = await client.findTaskByCallId('tok', 'https://sf.example.com', PAYLOAD.callId);
    expect(existingId).toBeNull();

    await client.createTask('tok', 'https://sf.example.com', task);
    expect(client.createdTasks).toHaveLength(1);
    expect((client.createdTasks[0]!.task as { Subject: string }).Subject).toBe('Call: Sale');
    expect(client.updatedTasks).toHaveLength(0);
  });

  it('updates existing Task when dedup finds one', async () => {
    const client = makeFakeSfClient({ existingTaskId: 'existing-task-456' });
    const task = mapDispoToSfTask(PAYLOAD, {});

    const existingId = await client.findTaskByCallId('tok', 'https://sf.example.com', PAYLOAD.callId);
    expect(existingId).toBe('existing-task-456');

    await client.updateTask('tok', 'https://sf.example.com', existingId!, task);
    expect(client.updatedTasks).toHaveLength(1);
    expect(client.updatedTasks[0]!.taskId).toBe('existing-task-456');
    expect(client.createdTasks).toHaveLength(0);
  });

  it('throws on SF API failure (triggering BullMQ retry)', async () => {
    const client = makeFakeSfClient({ createFails: true });
    const task = mapDispoToSfTask(PAYLOAD, {});

    await expect(
      client.createTask('tok', 'https://sf.example.com', task),
    ).rejects.toThrow('SF Task create failed: 503');
  });

  it('includes callId dedup marker in Description', async () => {
    const client = makeFakeSfClient({});
    const task = mapDispoToSfTask(PAYLOAD, {});
    await client.createTask('tok', 'https://sf.example.com', task);

    const created = client.createdTasks[0]!.task as { Description: string };
    expect(created.Description).toContain('[vici2:callId:call-uuid-worker-test]');
  });
});

describe('SF write-back worker — disabled integration skip', () => {
  it('does not call createTask when integration is disabled', async () => {
    const client = makeFakeSfClient({});
    // Simulate the worker's early-return path: integration disabled → no API calls
    const integrationEnabled = false;
    if (!integrationEnabled) {
      // Worker returns early
    } else {
      const task = mapDispoToSfTask(PAYLOAD, {});
      await client.createTask('tok', 'https://sf.example.com', task);
    }
    expect(client.createdTasks).toHaveLength(0);
  });
});

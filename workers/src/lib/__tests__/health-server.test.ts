import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkerHttpServer } from '../health-server.js';
import client from 'prom-client';
import http from 'node:http';

let portCounter = 19200;
const nextPort = () => ++portCounter;

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    }).on('error', reject);
  });
}

describe('WorkerHttpServer', () => {
  let server: WorkerHttpServer;
  let port: number;
  let registry: client.Registry;

  beforeEach(() => {
    port = nextPort();
    registry = new client.Registry();
  });

  afterEach(async () => {
    await server?.close();
  });

  it('/health always returns 200 with status ok', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [],
    });
    await server.listen();

    const { status, body } = await getJson(port, '/health');
    expect(status).toBe(200);
    expect((body as Record<string, string>).status).toBe('ok');
    expect((body as Record<string, string>).service).toBe('test-worker');
  });

  it('/ready returns 200 when all checks pass', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [
        { name: 'valkey', check: async () => true },
        { name: 'db', check: async () => true },
      ],
    });
    await server.listen();

    const { status, body } = await getJson(port, '/ready');
    expect(status).toBe(200);
    expect((body as Record<string, unknown>).ready).toBe(true);
    expect((body as Record<string, unknown>).checks).toMatchObject({
      valkey: 'ok',
      db: 'ok',
    });
  });

  it('/ready returns 503 when any check fails', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [
        { name: 'valkey', check: async () => true },
        { name: 'db', check: async () => false },
      ],
    });
    await server.listen();

    const { status, body } = await getJson(port, '/ready');
    expect(status).toBe(503);
    expect((body as Record<string, unknown>).ready).toBe(false);
    expect((body as Record<string, unknown>).checks).toMatchObject({ db: 'error' });
  });

  it('/ready returns 503 after setNotReady()', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [{ name: 'valkey', check: async () => true }],
    });
    await server.listen();

    // Initially healthy
    const r1 = await getJson(port, '/ready');
    expect(r1.status).toBe(200);

    server.setNotReady();

    const r2 = await getJson(port, '/ready');
    expect(r2.status).toBe(503);
    expect(((r2.body as Record<string, unknown>).checks as Record<string, string>).shutdown).toBe('in-progress');
  });

  it('/ready returns 503 when a check throws', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [
        {
          name: 'broken',
          check: async () => {
            throw new Error('connection refused');
          },
        },
      ],
    });
    await server.listen();

    const { status } = await getJson(port, '/ready');
    expect(status).toBe(503);
  });

  it('/ready respects timeoutMs per check', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [
        {
          name: 'slow',
          timeoutMs: 50,
          check: () =>
            new Promise((resolve) => setTimeout(() => resolve(true), 500)),
        },
      ],
    });
    await server.listen();

    const { status } = await getJson(port, '/ready');
    expect(status).toBe(503);
  });

  it('returns 404 for unknown paths', async () => {
    server = new WorkerHttpServer({
      port,
      metricsRegistry: registry,
      service: 'test-worker',
      readinessChecks: [],
    });
    await server.listen();

    const { status } = await getJson(port, '/unknown');
    expect(status).toBe(404);
  });
});

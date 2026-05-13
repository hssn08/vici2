/**
 * workers/src/lib/health-server.ts
 *
 * WorkerHttpServer — serves /health, /ready, /metrics on a configurable port.
 *
 * /health  — always 200 if process is alive.
 * /ready   — 200 when all readiness checks pass and not in shutdown; 503 otherwise.
 * /metrics — Prometheus text format (prom-client registry).
 *
 * Readiness results are cached for 5 seconds to avoid hammering dependencies.
 */

import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Registry } from 'prom-client';

export interface HealthCheck {
  name: string;
  check: () => Promise<boolean>;
  timeoutMs?: number;
}

export interface WorkerHttpServerOpts {
  port: number;
  metricsRegistry: Registry;
  service: string;
  readinessChecks: HealthCheck[];
}

export class WorkerHttpServer {
  private readonly server: http.Server;
  private ready = true;
  private cachedReadiness: { ok: boolean; checks: Record<string, string> } | null = null;
  private cacheExpiry = 0;

  constructor(private readonly opts: WorkerHttpServerOpts) {
    this.server = http.createServer(
      (req, res) => void this.handleRequest(req, res),
    );
  }

  /** Call during shutdown to flip /ready to 503 immediately. */
  setNotReady(): void {
    this.ready = false;
    this.cachedReadiness = null;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.url === '/metrics') {
      res.setHeader('content-type', this.opts.metricsRegistry.contentType);
      res.end(await this.opts.metricsRegistry.metrics());
    } else if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: this.opts.service }));
    } else if (req.url === '/ready') {
      const { ok, checks } = await this.getReadiness();
      res.statusCode = ok ? 200 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ ready: ok, service: this.opts.service, checks }),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  }

  private async getReadiness(): Promise<{
    ok: boolean;
    checks: Record<string, string>;
  }> {
    if (!this.ready) return { ok: false, checks: { shutdown: 'in-progress' } };

    const now = Date.now();
    if (this.cachedReadiness && now < this.cacheExpiry) {
      return this.cachedReadiness;
    }

    const checks: Record<string, string> = {};
    let allOk = true;

    for (const { name, check, timeoutMs = 2_000 } of this.opts.readinessChecks) {
      try {
        const result = await Promise.race([
          check(),
          new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
        ]);
        checks[name] = result ? 'ok' : 'error';
        if (!result) allOk = false;
      } catch {
        checks[name] = 'error';
        allOk = false;
      }
    }

    this.cachedReadiness = { ok: allOk, checks };
    this.cacheExpiry = now + 5_000;
    return this.cachedReadiness;
  }
}

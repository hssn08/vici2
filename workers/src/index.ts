// vici2 workers — background-job runner.
// F01 ships only a hello-world stub: pino JSON logger, /metrics on
// METRICS_PORT (default 9103). Actual jobs live under src/jobs/* and are
// added by D02 (CSV import), D05 (DNC sync), R02 (recording encode), N07
// (transcription), and others.

import "dotenv-flow/config";
import http from "node:http";
import client from "prom-client";
import pino from "pino";

const SERVICE = "workers";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: SERVICE },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const metricsPort = Number(process.env.METRICS_PORT ?? 9103);

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "vici2_workers_" });
const heartbeats = new client.Counter({
  name: "vici2_workers_heartbeats_total",
  help: "Number of /metrics scrapes observed.",
  registers: [registry],
});
const uptime = new client.Gauge({
  name: "vici2_workers_uptime_seconds",
  help: "Seconds since the workers process started.",
  registers: [registry],
  collect() {
    this.set(process.uptime());
  },
});
void uptime;

const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    heartbeats.inc();
    res.setHeader("content-type", registry.contentType);
    res.end(await registry.metrics());
    return;
  }
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", service: SERVICE }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(metricsPort, () => {
  logger.info({ port: metricsPort, module: "metrics" }, "workers metrics listening");
  logger.info({ module: "main" }, "workers idle (no jobs registered yet)");
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, "shutting down");
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// vici2 API — Fastify entry point.
// F01 ships only a hello-world stub: pino JSON logging, /health on the API
// port, /metrics on a separate port (default 9101). Routes are added by
// downstream modules (F05 auth, D01 leads, A04 manual dial, etc.).

import { env } from "./lib/env.js";
import Fastify from "fastify";
import client from "prom-client";
import http from "node:http";
import pino from "pino";

const SERVICE = "api";

const logger = pino({
  level: env.logLevel,
  base: { service: SERVICE },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ----- Prometheus registry --------------------------------------------------
// Per SPEC.md §3.6: vici2_<subsystem>_<unit>.
const registry = new client.Registry();
client.collectDefaultMetrics({
  register: registry,
  prefix: "vici2_api_",
});
const heartbeats = new client.Counter({
  name: "vici2_api_heartbeats_total",
  help: "Number of /metrics scrapes observed.",
  registers: [registry],
});
const uptimeGauge = new client.Gauge({
  name: "vici2_api_uptime_seconds",
  help: "Seconds since the api process started.",
  registers: [registry],
  collect() {
    this.set(process.uptime());
  },
});
void uptimeGauge;

// ----- Metrics HTTP server (separate port) ----------------------------------
const metricsServer = http.createServer(async (req, res) => {
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

metricsServer.listen(env.metricsPort, () => {
  logger.info({ port: env.metricsPort, module: "metrics" }, "metrics listening");
});

// ----- Main app -------------------------------------------------------------
// Fastify v5 requires a logger config object, not a pino instance directly.
const app = Fastify({
  loggerInstance: logger,
  disableRequestLogging: false,
  trustProxy: true,
});

app.get("/health", async () => ({ status: "ok", service: SERVICE }));
app.get("/", async () => ({ service: SERVICE, message: "hello from vici2 api" }));

import { registerAuthRoutes } from "./routes/auth/index.js";
import { registerCampaignRoutes } from "./routes/campaigns/index.js";

const start = async (): Promise<void> => {
  try {
    await registerAuthRoutes(app);
    await registerCampaignRoutes(app);
    await app.listen({ host: "0.0.0.0", port: env.port });
    logger.info({ port: env.port, module: "main" }, "api listening");
  } catch (err) {
    logger.error({ err }, "api failed to start");
    process.exit(1);
  }
};

void start();

// ----- Shutdown -------------------------------------------------------------
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "shutting down");
  await app.close();
  metricsServer.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

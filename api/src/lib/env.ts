// Loads .env via dotenv-flow at process boot. Imported for side-effects from
// src/server.ts. Real env validation comes in F05 / runtime config module.

import "dotenv-flow/config";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  metricsPort: Number(process.env.METRICS_PORT ?? 9101),
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
} as const;

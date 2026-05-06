// vici2 shared TypeScript types.
// Real types are added by F02 (DB-derived), N01 (REST API), and others.
// This stub lets pnpm workspace resolution work from day 1.

export type ServiceName = "api" | "dialer" | "workers" | "web";

export interface HealthResponse {
  status: "ok" | "degraded" | "unhealthy";
  service: ServiceName;
}

export const VICI2_VERSION = "0.0.0" as const;

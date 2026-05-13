// Env loading + validation. F05 expands the F01 stub to require auth-config
// vars; loud failure if anything critical is missing (per PLAN §15.1).

import "dotenv-flow/config";

const FALSY = new Set(["false", "0", "no", "off", ""]);

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return !FALSY.has(v.toLowerCase());
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: num(process.env.API_HTTP_PORT ?? process.env.PORT, 3000),
  metricsPort: num(process.env.API_METRICS_PORT ?? process.env.METRICS_PORT, 9101),
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.VICI2_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379/0",

  jwtAlg: process.env.VICI2_JWT_ALG ?? "EdDSA",
  jwtPrivateKeyJwk: process.env.VICI2_JWT_PRIVATE_KEY_JWK ?? "",
  jwtPublicKeysJwks: process.env.VICI2_JWT_PUBLIC_KEYS_JWKS ?? "",
  jwtIssuer: process.env.VICI2_JWT_ISSUER ?? "vici2-api",

  kekCurrentVersion: num(process.env.VICI2_KEK_CURRENT_VERSION, 1),
  passwordPepper: process.env.VICI2_PASSWORD_PEPPER ?? "",
  hibpOffline: bool(process.env.HIBP_OFFLINE, false),

  accessTokenTtlSec: num(process.env.VICI2_ACCESS_TTL_SEC, 900),
  refreshTtlAgentSec: num(process.env.VICI2_REFRESH_TTL_AGENT_SEC, 30 * 24 * 3600),
  refreshTtlAdminSec: num(process.env.VICI2_REFRESH_TTL_ADMIN_SEC, 7 * 24 * 3600),
  refreshTtlIntegratorSec: num(process.env.VICI2_REFRESH_TTL_INTEGRATOR_SEC, 60 * 60),

  bootstrapSuperadminEmail: process.env.BOOTSTRAP_SUPERADMIN_EMAIL ?? "",
  bootstrapSuperadminPassword: process.env.BOOTSTRAP_SUPERADMIN_PASSWORD ?? "",
  bootstrapSuperadminTenantId: num(process.env.BOOTSTRAP_SUPERADMIN_TENANT_ID, 1),

  // N04 HubSpot integration
  hubspotClientId:     process.env.HUBSPOT_CLIENT_ID ?? "",
  hubspotClientSecret: process.env.HUBSPOT_CLIENT_SECRET ?? "",
  hubspotRedirectUri:  process.env.HUBSPOT_REDIRECT_URI ?? "",
  hubspotAppToken:     process.env.HUBSPOT_APP_TOKEN ?? "",

  // N01 SMTP (Phase 1 — plain nodemailer; SES/Postmark Phase 2)
  smtpHost: process.env.VICI2_SMTP_HOST ?? "",
  smtpPort: num(process.env.VICI2_SMTP_PORT, 587),
  smtpUser: process.env.VICI2_SMTP_USER ?? "",
  smtpPass: process.env.VICI2_SMTP_PASS ?? "",
  smtpFrom: process.env.VICI2_SMTP_FROM ?? "Vici2 <noreply@example.com>",
  smtpTls: bool(process.env.VICI2_SMTP_TLS, true),
} as const;

export function kekVersionEnv(version: number): string {
  return process.env[`VICI2_KEK_V${version}`] ?? "";
}

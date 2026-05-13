// TENANT_SCOPED_TABLES — Prisma models that always require a tenantId filter.
// Used by the tenant-scope Prisma middleware (M02 PLAN §10.2).
//
// IMPORTANT: add every new Prisma model here OR to GLOBAL_TABLES.
// CI gate in scripts/ci/check-rbac-coverage.sh enforces full coverage.

export const TENANT_SCOPED_TABLES = new Set<string>([
  'User',
  'UserGroup',
  'Campaign',
  'Lead',
  'Callback',
  'Recording',
  'AuditLog',
  'Carrier',
  'Did',
  'Ingroup',
  'DncList',
  'DncEntry',
  'Script',
  'Status',
  'PauseCode',
  'SipCredential',
  'AuthConfig',
]);

/** Tables that are global (no tenantId column) — exempt from the middleware. */
export const GLOBAL_TABLES = new Set<string>([
  'Tenant',
  'Migrations',
]);

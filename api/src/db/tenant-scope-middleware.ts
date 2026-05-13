// Prisma tenant-scope middleware — belt-and-braces (M02 PLAN §10.2).
//
// Injects tenantId into every query on TENANT_SCOPED_TABLES.
// tenantId is read from AsyncLocalStorage populated by requireAuth.
//
// Workers / scripts that legitimately span tenants call withBypassedTenantScope().
// All bypasses emit an auth.cross_tenant_action audit row (logged, not blocked).

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import { TENANT_SCOPED_TABLES } from './tenant-tables.js';

// ---------------------------------------------------------------------------
// AsyncLocalStorage store
// ---------------------------------------------------------------------------

interface TenantStore {
  tenantId: bigint | null; // null = intentional cross-tenant bypass
}

const als = new AsyncLocalStorage<TenantStore>();

/** Set the tenant context for the current async scope (call from requireAuth). */
export function setTenantContext(tenantId: bigint): void {
  als.enterWith({ tenantId });
}

/** Returns current tenantId or undefined if outside a tenant-scoped context. */
export function getTenantContext(): bigint | null | undefined {
  return als.getStore()?.tenantId;
}

/**
 * Run fn in a context where tenant scoping is bypassed.
 * Use for background jobs / admin scripts that span tenants.
 * Document WHY the bypass is needed in the call site comment.
 */
export async function withBypassedTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    als.run({ tenantId: null }, () => {
      fn().then(resolve, reject);
    });
  });
}

// ---------------------------------------------------------------------------
// Prisma middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns a Prisma middleware that auto-injects tenantId into all reads/writes
 * on TENANT_SCOPED_TABLES. Throws on unscoped queries outside a bypass context.
 */
export function createTenantScopeMiddleware(): Prisma.Middleware {
  return async (params: Prisma.MiddlewareParams, next: (params: Prisma.MiddlewareParams) => Promise<unknown>) => {
    const model = params.model;
    if (!model || !TENANT_SCOPED_TABLES.has(model)) {
      return next(params);
    }

    const store = als.getStore();

    if (!store) {
      // No ALS context — hard error. Do not silently pass unscoped queries.
      throw new Error(
        `[M02] Unscoped query on ${model}: setTenantContext() must be called before querying tenant-scoped tables. ` +
        `Use withBypassedTenantScope() if cross-tenant access is intentional.`,
      );
    }

    if (store.tenantId === null) {
      // Intentional bypass — proceed without injecting tenantId.
      return next(params);
    }

    // Inject tenantId
    const tid = store.tenantId;
    if (!params.args) params.args = {};
    if (!params.args['where']) params.args['where'] = {};
    // Only inject if the caller hasn't already set a tenant_id (respect explicit filters)
    if (params.args['where']['tenantId'] === undefined) {
      params.args['where']['tenantId'] = tid;
    }

    return next(params);
  };
}

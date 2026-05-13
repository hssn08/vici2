// BullMQ RBAC wrapper (M02 PLAN §8.3).
//
// Usage:
//   const handler = wrapJob(
//     { requires: 'lead:import', extractScope: (job) => ({ tenantId: BigInt(job.data.tenantId) }) },
//     async (job, auth) => { ... },
//   );
//
// RBAC is checked BOTH at enqueue (Fastify preHandler) and at dequeue time here —
// defense in depth against role changes between enqueue and execution.

import type { Job } from 'bullmq';
import { Can, type AuthContext, type ScopeContext } from '@vici2/auth/rbac';
import type { AuditWriter } from '@vici2/auth/rbac/audit';
import { auditDecision } from '@vici2/auth/rbac/audit';
import type { Verb } from '@vici2/types';

export interface WrapJobOpts<T> {
  requires:      Verb;
  extractScope?: (job: Job<T>) => ScopeContext;
  /**
   * Async function that builds an AuthContext from job.data.
   * Must hydrate allowedCampaigns, role, userGroupId, etc. from DB/Valkey.
   */
  buildAuth:     (job: Job<T>) => Promise<AuthContext>;
  /**
   * AuditWriter for deny + sensitive-allow events.
   * If not supplied, audit write is skipped (not recommended for production).
   */
  auditWriter?:  AuditWriter;
}

/**
 * Wrap a BullMQ job handler with RBAC enforcement.
 * Returns a function compatible with `worker.processJobs`.
 */
export function wrapJob<T>(
  opts:    WrapJobOpts<T>,
  handler: (job: Job<T>, auth: AuthContext) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  return async (job: Job<T>): Promise<void> => {
    const auth = await opts.buildAuth(job);
    const scope: ScopeContext = opts.extractScope?.(job) ?? { tenantId: auth.tenantId };

    const decision = Can(auth, opts.requires, scope);

    if (opts.auditWriter) {
      await auditDecision(opts.auditWriter, auth, opts.requires, scope, decision);
    }

    if (!decision.allow) {
      throw new Error(`rbac:denied reason=${decision.reason} verb=${opts.requires} uid=${auth.uid}`);
    }

    return handler(job, auth);
  };
}

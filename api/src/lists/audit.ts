// D07 — List-specific audit actions (C03 chain compatible).

import { audit as coreAudit } from "../auth/audit.js";
import type { AuditInput } from "../auth/audit.js";

export type ListAuditAction =
  | "list.created"
  | "list.updated"
  | "list.deleted"
  | "list.reset.queued"
  | "list.reset.completed"
  | "list.reset.failed"
  | "list.purge.queued"
  | "list.purge.completed"
  | "list.purge.failed"
  | "list.cloned"
  | "list.campaign.linked"
  | "list.campaign.unlinked"
  | "list.campaign.updated";

export type ListAuditInput = Omit<AuditInput, "action" | "entityType"> & {
  action: ListAuditAction;
  entityId: string;
};

export async function auditList(opts: ListAuditInput): Promise<void> {
  await coreAudit({
    ...opts,
    action: opts.action as Parameters<typeof coreAudit>[0]["action"],
    entityType: "list",
  });
}

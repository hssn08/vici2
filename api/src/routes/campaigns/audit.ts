// E01 — Campaign-specific audit actions.

import { audit as coreAudit } from "../../auth/audit.js";
import type { AuditInput } from "../../auth/audit.js";
import { Prisma } from "@prisma/client";

export type CampaignAuditAction =
  | "campaign.created"
  | "campaign.updated"
  | "campaign.deleted"
  | "campaign.cloned"
  | "campaign.started"
  | "campaign.paused"
  | "campaign.stopped"
  | "campaign.list.linked"
  | "campaign.list.unlinked"
  | "campaign.status_override.upserted"
  | "campaign.status_override.deleted";

export type CampaignAuditInput = Omit<AuditInput, "action" | "entityType"> & {
  action: CampaignAuditAction;
  entityId: string;
};

export async function auditCampaign(opts: CampaignAuditInput): Promise<void> {
  await coreAudit({
    ...opts,
    // Widen to the AuditAction union — the DB column is VarChar(64),
    // so any string is accepted; the type union in audit.ts is for auth
    // actions only. We cast here intentionally.
    action: opts.action as Parameters<typeof coreAudit>[0]["action"],
    entityType: "campaign",
  });
}

export { Prisma };

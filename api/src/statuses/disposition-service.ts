// D04 — dispositionService.submit()
//
// Writes disposition row + lead status + call_log status in a single transaction.
// Emits lead.status_changed event after commit.
// Fires DNC/sale side-effects non-blocking.

import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { StatusService } from "./service.js";
import { publishLeadStatusChanged } from "./events.js";
import {
  dispositionWritesTotal,
  dispositionWriteLatencyMs,
  dncSideEffectTotal,
  crmWebhookTotal,
} from "./metrics.js";

const logger = pino({ level: "info" });

export interface DispositionInput {
  tenantId: bigint;
  campaignId: string;
  leadId: bigint;
  callUuid: string;
  statusCode: string;
  previousStatus: string;
  phoneE164: string;
  userId?: number | null;
  agentNotes?: string | null;
}

export interface DispositionResult {
  id: bigint;
  disposedAt: Date;
  statusCode: string;
  leadId: bigint;
}

// Interface for DNC service (D05 owns implementation)
interface DncServiceStub {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addInternal(params: any): Promise<void>;
}

// Interface for CRM webhook (N01 owns implementation)
interface WebhookServiceStub {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fire(url: string, payload: any): Promise<void>;
}

export class DispositionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly statusService: StatusService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly redis: any,
    private readonly dncService?: DncServiceStub,
    private readonly webhookService?: WebhookServiceStub,
  ) {}

  async submit(req: DispositionInput): Promise<DispositionResult> {
    const startMs = Date.now();

    // Resolve effective status for the campaign
    const status = await this.statusService.resolve(req.tenantId, req.campaignId, req.statusCode);
    if (!status) {
      dispositionWritesTotal.inc({ status: req.statusCode, outcome: "error_not_found" });
      throw Object.assign(new Error("status_not_found"), { statusCode: 404, errorCode: "status_not_found" });
    }

    // Only agent-selectable statuses can be submitted via API
    if (!status.selectable) {
      dispositionWritesTotal.inc({ status: req.statusCode, outcome: "error_not_selectable" });
      throw Object.assign(new Error("status_not_agent_selectable"), { statusCode: 403, errorCode: "status_not_agent_selectable" });
    }

    // Block illegal "to" codes (QUEUE, INCALL, NEW, INVALID) — belt-and-suspenders
    const SYSTEM_ONLY = new Set(["QUEUE", "INCALL", "NEW", "INVALID"]);
    if (SYSTEM_ONLY.has(req.statusCode)) {
      dispositionWritesTotal.inc({ status: req.statusCode, outcome: "error_illegal" });
      throw Object.assign(new Error("illegal_disposition_code"), { statusCode: 400, errorCode: "illegal_disposition_code" });
    }

    let dispositionId: bigint;
    let disposedAt: Date;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.prisma.$transaction(async (tx: any) => {
        // Write disposition row
        // Note: dispositions table is owned by D01/F02; we use raw SQL for now
        // as Prisma model may not yet have this table.
        const now = new Date();

        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO dispositions
               (tenant_id, campaign_id, lead_id, call_uuid, status_code, disposed_at,
                user_id, agent_notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            req.tenantId,
            req.campaignId,
            req.leadId,
            req.callUuid,
            req.statusCode,
            now,
            req.userId ?? null,
            req.agentNotes ?? null,
          );
        } catch (err: unknown) {
          // If dispositions table doesn't exist yet (Phase 0), skip gracefully
          const e = err as { code?: string; message?: string };
          if (!e.message?.includes("doesn't exist")) throw err;
          logger.warn("d04:disposition: dispositions table not found, skipping insert");
        }

        // Update lead status + increment called_count + last_called_at
        const leadUpdate = await tx.$executeRawUnsafe(
          `UPDATE leads
           SET status = ?, modify_at = NOW(), called_count = called_count + 1, last_called_at = NOW()
           WHERE id = ? AND tenant_id = ?`,
          req.statusCode,
          req.leadId,
          req.tenantId,
        );

        if ((leadUpdate as unknown as number) === 0) {
          throw Object.assign(new Error("lead_gone"), { statusCode: 404, errorCode: "lead_gone" });
        }

        // Update call_log status
        try {
          await tx.$executeRawUnsafe(
            `UPDATE call_log SET status = ?, updated_at = NOW() WHERE uuid = ? AND tenant_id = ?`,
            req.statusCode,
            req.callUuid,
            req.tenantId,
          );
        } catch (err: unknown) {
          const e = err as { message?: string };
          if (!e.message?.includes("doesn't exist")) throw err;
          logger.warn("d04:disposition: call_log table not found, skipping update");
        }

        // Audit event
        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO audit_log
               (tenant_id, action, entity_type, entity_id, actor_id, payload, created_at, updated_at)
             VALUES (?, 'lead.status_changed', 'lead', ?, ?, JSON_OBJECT(
               'old_status', ?,
               'new_status', ?,
               'campaign_id', ?,
               'call_uuid', ?
             ), NOW(), NOW())`,
            req.tenantId,
            req.leadId,
            req.userId ?? null,
            req.previousStatus,
            req.statusCode,
            req.campaignId,
            req.callUuid,
          );
        } catch (err: unknown) {
          const e = err as { message?: string };
          if (!e.message?.includes("doesn't exist")) throw err;
        }

        return { disposedAt: now };
      });

      disposedAt = result.disposedAt;
      dispositionId = BigInt(0); // placeholder until dispositions table has autoincrement
    } catch (err) {
      dispositionWritesTotal.inc({ status: req.statusCode, outcome: "error" });
      dispositionWriteLatencyMs.observe(Date.now() - startMs);
      throw err;
    }

    dispositionWritesTotal.inc({ status: req.statusCode, outcome: "ok" });
    dispositionWriteLatencyMs.observe(Date.now() - startMs);

    // ── Non-blocking side-effects (after transaction commits) ─────────────────

    // DNC side-effect
    if (status.dnc && this.dncService) {
      this.dncService
        .addInternal({
          tenantId: req.tenantId,
          phoneE164: req.phoneE164,
          source: "internal",
          campaignId: "__GLOBAL__",
          addedBy: req.userId,
        })
        .then(() => dncSideEffectTotal.inc({ outcome: "ok" }))
        .catch((err) => {
          logger.error({ err }, "d04:disposition: dnc_add_failed");
          dncSideEffectTotal.inc({ outcome: "error" });
        });
    }

    // Sale CRM webhook
    if (status.sale && this.webhookService) {
      this.webhookService
        .fire("", req) // URL comes from campaign config — caller responsibility
        .then(() => crmWebhookTotal.inc({ outcome: "ok" }))
        .catch((err) => {
          logger.error({ err }, "d04:disposition: crm_webhook_failed");
          crmWebhookTotal.inc({ outcome: "error" });
        });
    }

    // Publish lead.status_changed event
    publishLeadStatusChanged(this.redis, {
      tenantId: req.tenantId,
      leadId: req.leadId,
      oldStatus: req.previousStatus,
      newStatus: req.statusCode,
      timestamp: disposedAt,
      userId: req.userId,
      campaignId: req.campaignId,
    }).catch((err) => logger.error({ err }, "d04:disposition: event_publish_failed"));

    return {
      id: dispositionId,
      disposedAt,
      statusCode: req.statusCode,
      leadId: req.leadId,
    };
  }
}

/**
 * api/src/services/audit/writer.ts — AuditWriter
 *
 * Low-latency, chain-preserving append to any immutable audit table.
 *
 * Phase 1 contract (PLAN §10.2):
 *   - Validates input with per-table Zod schema (no 0x1F, no NUL, ≤4 KB JSON)
 *   - Issues the INSERT via Prisma (trigger fires, hash chain extended)
 *   - Returns { id, rowHash } to caller
 *   - On error: bubbles up — caller MUST propagate (no silent drop)
 *
 * The INSERT path uses $queryRaw for tables not natively modelled in Prisma
 * because the chain columns are set by the DB trigger (not by Prisma logic).
 * For audit_log, we use the existing Prisma model and let the trigger populate
 * prev_hash / row_hash / hash_at.
 *
 * Phase 4: swap with Valkey-stream batched writer (no API change).
 */

import type { PrismaClient } from '@prisma/client';
import {
  AuditLogInputSchema,
  CallWindowAuditInputSchema,
  ConsentLogInputSchema,
  DncSyncLogInputSchema,
  OriginateAuditInputSchema,
  type AuditLogInput,
  type CallWindowAuditInput,
  type ConsentLogInput,
  type DncSyncLogInput,
  type OriginateAuditInput,
} from './events.js';

export type AuditTable =
  | 'audit_log'
  | 'call_window_audit'
  | 'originate_audit'
  | 'consent_log'
  | 'dnc_sync_log';

export interface AppendResult {
  id: bigint;
  rowHash: string;
}

export class AuditWriter {
  constructor(private readonly db: PrismaClient) {}

  async appendAuditLog(entry: AuditLogInput): Promise<AppendResult> {
    const data = AuditLogInputSchema.parse(entry);
    // Use raw INSERT so the BEFORE INSERT trigger fires and populates row_hash.
    // Prisma's createMany/create would also work (trigger fires either way),
    // but we need LAST_INSERT_ID() + SELECT row_hash back.
    const rows = await this.db.$queryRaw<{ id: bigint; row_hash: string }[]>`
      INSERT INTO audit_log
        (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id,
         before_json, after_json, request_id, ip_address, user_agent, ts)
      VALUES (
        ${data.tenantId}, ${data.actorUserId ?? null}, ${data.actorKind},
        ${data.action}, ${data.entityType}, ${data.entityId ?? null},
        ${data.beforeJson != null ? JSON.stringify(data.beforeJson) : null},
        ${data.afterJson != null ? JSON.stringify(data.afterJson) : null},
        ${data.requestId ?? null}, ${data.ipAddress ?? null}, ${data.userAgent ?? null},
        ${data.ts}
      );
      SELECT LAST_INSERT_ID() AS id,
             (SELECT row_hash FROM audit_log WHERE id = LAST_INSERT_ID() LIMIT 1) AS row_hash
    `;
    const result = rows[0] ?? rows[rows.length - 1];
    return { id: result.id, rowHash: result.row_hash };
  }

  async appendCallWindowAudit(entry: CallWindowAuditInput): Promise<AppendResult> {
    const data = CallWindowAuditInputSchema.parse(entry);
    const rows = await this.db.$queryRaw<{ id: bigint; row_hash: string }[]>`
      INSERT INTO call_window_audit
        (tenant_id, lead_id, phone_e164, campaign_id, decision, reason,
         tz_iana, tz_confidence, state_code, zip, party_local, party_dow,
         effective_open_min, effective_close_min, rule_applied,
         enforcement_point, next_open_at, call_uuid)
      VALUES (
        ${data.tenantId}, ${data.leadId}, ${data.phoneE164}, ${data.campaignId},
        ${data.decision}, ${data.reason},
        ${data.tzIana ?? null}, ${data.tzConfidence ?? null},
        ${data.stateCode ?? null}, ${data.zip ?? null},
        ${data.partyLocal ?? null}, ${data.partyDow ?? null},
        ${data.effectiveOpenMin ?? null}, ${data.effectiveCloseMin ?? null},
        ${data.ruleApplied ?? null}, ${data.enforcementPoint},
        ${data.nextOpenAt ?? null}, ${data.callUuid ?? null}
      );
      SELECT LAST_INSERT_ID() AS id,
             (SELECT row_hash FROM call_window_audit WHERE id = LAST_INSERT_ID() LIMIT 1) AS row_hash
    `;
    const result = rows[0] ?? rows[rows.length - 1];
    return { id: result.id, rowHash: result.row_hash };
  }

  async appendOriginateAudit(entry: OriginateAuditInput): Promise<AppendResult> {
    const data = OriginateAuditInputSchema.parse(entry);
    const rows = await this.db.$queryRaw<{ id: bigint; row_hash: string }[]>`
      INSERT INTO originate_audit
        (tenant_id, attempt_uuid, call_uuid, lead_id, campaign_id, list_id, agent_id,
         mode, dial_target, carrier_id, gateway_id, gateway_name,
         caller_id_number, caller_id_source, phone_e164, originated_at,
         tcpa_decision, tcpa_reason, tcpa_tz_resolved,
         dnc_decision, dnc_sources, consent_decision, consent_state,
         bypass_token, outcome, outcome_at, duration_ms,
         error_message, fs_host, request_id, ip_address)
      VALUES (
        ${data.tenantId}, ${data.attemptUuid}, ${data.callUuid ?? null},
        ${data.leadId}, ${data.campaignId ?? null}, ${data.listId ?? null},
        ${data.agentId ?? null}, ${data.mode}, ${data.dialTarget},
        ${data.carrierId ?? null}, ${data.gatewayId ?? null},
        ${data.gatewayName ?? null}, ${data.callerIdNumber ?? null},
        ${data.callerIdSource ?? null}, ${data.phoneE164}, ${data.originatedAt},
        ${data.tcpaDecision ?? null}, ${data.tcpaReason ?? null},
        ${data.tcpaTzResolved ?? null}, ${data.dncDecision ?? null},
        ${data.dncSources != null ? JSON.stringify(data.dncSources) : null},
        ${data.consentDecision ?? null}, ${data.consentState ?? null},
        ${data.bypassToken ?? null}, ${data.outcome},
        ${data.outcomeAt ?? null}, ${data.durationMs ?? null},
        ${data.errorMessage ?? null}, ${data.fsHost ?? null},
        ${data.requestId ?? null}, ${data.ipAddress ?? null}
      );
      SELECT LAST_INSERT_ID() AS id,
             (SELECT row_hash FROM originate_audit WHERE id = LAST_INSERT_ID() LIMIT 1) AS row_hash
    `;
    const result = rows[0] ?? rows[rows.length - 1];
    return { id: result.id, rowHash: result.row_hash };
  }

  async appendConsentLog(entry: ConsentLogInput): Promise<AppendResult> {
    const data = ConsentLogInputSchema.parse(entry);
    const rows = await this.db.$queryRaw<{ id: bigint; row_hash: string }[]>`
      INSERT INTO consent_log
        (tenant_id, call_uuid, lead_id, phone_e164, prompt_id,
         dtmf_response, outcome, language, prompt_played_at)
      VALUES (
        ${data.tenantId}, ${data.callUuid}, ${data.leadId}, ${data.phoneE164},
        ${data.promptId}, ${data.dtmfResponse ?? null}, ${data.outcome},
        ${data.language}, ${data.promptPlayedAt}
      );
      SELECT LAST_INSERT_ID() AS id,
             (SELECT row_hash FROM consent_log WHERE id = LAST_INSERT_ID() LIMIT 1) AS row_hash
    `;
    const result = rows[0] ?? rows[rows.length - 1];
    return { id: result.id, rowHash: result.row_hash };
  }

  async appendDncSyncLog(entry: DncSyncLogInput): Promise<AppendResult> {
    const data = DncSyncLogInputSchema.parse(entry);
    const rows = await this.db.$queryRaw<{ id: bigint; row_hash: string }[]>`
      INSERT INTO dnc_sync_log
        (source, kind, outcome, added, removed, error_count,
         file_hash, started_at, completed_at, duration_ms, notes)
      VALUES (
        ${data.source}, ${data.kind}, ${data.outcome},
        ${data.added}, ${data.removed}, ${data.errorCount},
        ${data.fileHash ?? null}, ${data.startedAt},
        ${data.completedAt ?? null}, ${data.durationMs ?? null},
        ${data.notes ?? null}
      );
      SELECT LAST_INSERT_ID() AS id,
             (SELECT row_hash FROM dnc_sync_log WHERE id = LAST_INSERT_ID() LIMIT 1) AS row_hash
    `;
    const result = rows[0] ?? rows[rows.length - 1];
    return { id: result.id, rowHash: result.row_hash };
  }
}

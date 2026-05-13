// D06 — Callbacks service: CRUD, claim, reassign, bulk-reassign, onNoAnswer.
// Scope: user_id IS NULL = GLOBAL; NOT NULL = AGENT.

import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../auth/middleware.js";
import { guardTransition } from "./state-machine.js";
import { writeCallbackAudit } from "./audit.js";
import { publishCallbackEvent, notifyAgent, isAgentOnline } from "./events.js";
import {
  callbackScheduledTotal,
  callbackCancelledTotal,
  callbackSnoozedTotal,
  callbackCompletedTotal,
  claimRaceTotal,
  bulkReassignTotal,
} from "./metrics.js";
import type {
  CreateCallbackBodyType,
  SnoozeBodyType,
  ReassignBodyType,
  BulkReassignBodyType,
} from "./schemas.js";
import { validateCallbackAt } from "./schemas.js";
import { isSupervisor, canCancel, canSnooze } from "./rbac.js";
import pino from "pino";

const logger = pino({ level: "info" });

// ── TCPA stub (Phase 1 — C01 micro-amendment deferred) ───────────────────────
// C01 must add 'callback_schedule' and 'callback_fire' to EnforcementPoint enum.
// Until C01 lands, this stub returns ALLOW for all calls so Phase-1 schedules work.

export type TcpaOutcome = "ALLOW" | "SKIP_UNTIL" | "BLOCK_INVALID";
export interface TcpaResult {
  outcome: TcpaOutcome;
  nextOpen?: Date;
  reason?: string;
}

export async function checkTcpa(_params: {
  leadTzIana: string | null;
  when: Date;
  enforcementPoint: "callback_schedule" | "callback_fire";
}): Promise<TcpaResult> {
  // Phase 1 stub — always ALLOW. C01 IMPLEMENT wires the real gate.
  return { outcome: "ALLOW" };
}

// ── Scope resolution ──────────────────────────────────────────────────────────

export function resolveUserId(
  body: { agent_only?: boolean; user_id?: bigint },
  actor: AuthContext,
): { userId: bigint | null; error?: string } {
  if (body.user_id != null) {
    if (!isSupervisor(actor)) return { userId: null, error: "invalid_scope" };
    if (body.agent_only && body.user_id !== BigInt(actor.uid)) {
      return { userId: null, error: "invalid_scope" };
    }
    return { userId: body.user_id };
  }
  return { userId: body.agent_only ? BigInt(actor.uid) : null };
}

// ── Serialise callback for API response ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeCallback(cb: any): Record<string, unknown> {
  return {
    id: String(cb.id),
    tenant_id: String(cb.tenantId),
    lead_id: String(cb.leadId),
    campaign_id: cb.campaignId,
    user_id: cb.userId != null ? String(cb.userId) : null,
    scope: cb.userId != null ? "AGENT" : "GLOBAL",
    callback_at: cb.callbackAt instanceof Date ? cb.callbackAt.toISOString() : cb.callbackAt,
    status: cb.status,
    comments: cb.comments ?? null,
    lead_tz_iana: cb.lead?.knownTimezone ?? null,
    created_at: cb.createdAt instanceof Date ? cb.createdAt.toISOString() : cb.createdAt,
    updated_at: cb.updatedAt instanceof Date ? cb.updatedAt.toISOString() : cb.updatedAt,
  };
}

// ── Create callback ───────────────────────────────────────────────────────────

export async function createCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  actor: AuthContext,
  body: CreateCallbackBodyType,
): Promise<{ callback: Record<string, unknown>; tcpaWarning?: TcpaResult }> {
  const atCheck = validateCallbackAt(body.callback_at);
  if (!atCheck.ok) throw Object.assign(new Error(atCheck.code), { statusCode: 400, code: atCheck.code });

  const { userId, error } = resolveUserId(body, actor);
  if (error) throw Object.assign(new Error(error), { statusCode: 400, code: error });

  const tenantId = BigInt(actor.tenantId);

  // Load lead to get TZ for TCPA dry-run
  const lead = await prisma.lead.findFirst({
    where: { id: body.lead_id, tenantId, deletedAt: null },
    select: { id: true, knownTimezone: true, status: true },
  });
  if (!lead) throw Object.assign(new Error("lead_not_found"), { statusCode: 404, code: "lead_not_found" });

  // TCPA dry-run at schedule time (warn only, not enforce)
  const tcpa = await checkTcpa({
    leadTzIana: lead.knownTimezone,
    when: new Date(body.callback_at),
    enforcementPoint: "callback_schedule",
  });

  const callbackAt = new Date(body.callback_at);

  const callback = await prisma.$transaction(async (tx) => {
    // Create callback row
    const cb = await tx.callback.create({
      data: {
        tenantId,
        leadId: body.lead_id,
        campaignId: body.campaign_id,
        userId,
        callbackAt,
        comments: body.comments ?? null,
        status: "PENDING",
        createdBy: BigInt(actor.uid),
      },
    });

    // Set lead to CBHOLD if it's not already in a callback lifecycle status
    // Only set CBHOLD if lead has no existing PENDING callbacks
    const existingPending = await tx.callback.count({
      where: {
        tenantId,
        leadId: body.lead_id,
        status: "PENDING",
        id: { not: cb.id },
      },
    });

    if (existingPending === 0 && !["CBHOLD", "CALLBK"].includes(lead.status)) {
      await tx.lead.update({
        where: { id: body.lead_id },
        data: { status: "CBHOLD", modifyAt: new Date() },
      });
    }

    // Audit
    await tx.auditLog.create({
      data: {
        tenantId,
        actorKind: "user",
        actorUserId: BigInt(actor.uid),
        action: "callback.scheduled",
        entityType: "callback",
        entityId: String(cb.id),
        afterJson: {
          scope: userId != null ? "AGENT" : "GLOBAL",
          callback_at: callbackAt.toISOString(),
          tcpa_outcome: tcpa.outcome,
        },
        ts: new Date(),
      },
    });

    return cb;
  });

  const scope = userId != null ? "AGENT" : "GLOBAL";
  callbackScheduledTotal.inc({ scope });

  // After-commit events
  await publishCallbackEvent(redis, {
    type: "callback_scheduled",
    tenantId,
    callbackId: callback.id,
    leadId: body.lead_id,
    userId,
    campaignId: body.campaign_id,
    ts: new Date().toISOString(),
  });

  const result = serializeCallback({ ...callback, lead });
  return {
    callback: result,
    tcpaWarning: tcpa.outcome !== "ALLOW" ? tcpa : undefined,
  };
}

// ── List "my callbacks" (agent) ───────────────────────────────────────────────

export async function listMineCallbacks(
  prisma: PrismaClient,
  actor: AuthContext,
  opts: { cursor?: bigint; limit?: number },
): Promise<{ callbacks: Record<string, unknown>[]; next_cursor: string | null }> {
  const tenantId = BigInt(actor.tenantId);
  const limit = opts.limit ?? 50;

  const rows = await prisma.callback.findMany({
    where: {
      tenantId,
      userId: BigInt(actor.uid),
      status: { in: ["PENDING", "LIVE"] },
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    },
    include: { lead: { select: { knownTimezone: true, firstName: true, lastName: true, phoneE164: true } } },
    orderBy: [{ status: "asc" }, { callbackAt: "asc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const nextCursor = hasMore ? String(rows[rows.length - 1]?.id) : null;

  return { callbacks: rows.map(serializeCallback), next_cursor: nextCursor };
}

// ── Snooze callback ───────────────────────────────────────────────────────────

export async function snoozeCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  actor: AuthContext,
  callbackId: bigint,
  body: SnoozeBodyType,
): Promise<Record<string, unknown>> {
  const atCheck = validateCallbackAt(body.callback_at);
  if (!atCheck.ok) throw Object.assign(new Error(atCheck.code), { statusCode: 400, code: atCheck.code });

  const tenantId = BigInt(actor.tenantId);
  const cb = await prisma.callback.findFirst({ where: { id: callbackId, tenantId } });
  if (!cb) throw Object.assign(new Error("callback_not_found"), { statusCode: 404, code: "callback_not_found" });

  if (!canSnooze(actor, cb.userId)) {
    throw Object.assign(new Error("permission_denied"), { statusCode: 403, code: "permission_denied" });
  }

  const guard = guardTransition(cb.status, "PENDING");
  if (!guard.ok) throw Object.assign(new Error(guard.errorCode!), { statusCode: 409, code: guard.errorCode });

  const newAt = new Date(body.callback_at);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.callback.update({
      where: { id: callbackId },
      data: { callbackAt: newAt, comments: body.comments ?? cb.comments, status: "PENDING" },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        actorKind: "user",
        actorUserId: BigInt(actor.uid),
        action: "callback.snoozed",
        entityType: "callback",
        entityId: String(callbackId),
        afterJson: { new_callback_at: newAt.toISOString() },
        ts: new Date(),
      },
    });
    return u;
  });

  callbackSnoozedTotal.inc();
  await publishCallbackEvent(redis, {
    type: "callback_snoozed",
    tenantId,
    callbackId,
    leadId: cb.leadId,
    userId: cb.userId,
    ts: new Date().toISOString(),
  });

  return serializeCallback(updated);
}

// ── Cancel callback ───────────────────────────────────────────────────────────

export async function cancelCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  actor: AuthContext,
  callbackId: bigint,
): Promise<{ cancelled: true }> {
  const tenantId = BigInt(actor.tenantId);
  const cb = await prisma.callback.findFirst({ where: { id: callbackId, tenantId } });
  if (!cb) throw Object.assign(new Error("callback_not_found"), { statusCode: 404, code: "callback_not_found" });

  if (!canCancel(actor, cb.userId)) {
    throw Object.assign(new Error("permission_denied"), { statusCode: 403, code: "permission_denied" });
  }

  const guard = guardTransition(cb.status, "DEAD");
  if (!guard.ok) throw Object.assign(new Error(guard.errorCode!), { statusCode: 409, code: guard.errorCode });

  await prisma.$transaction(async (tx) => {
    await tx.callback.update({ where: { id: callbackId }, data: { status: "DEAD" } });

    // Restore lead status if this was the last PENDING/LIVE callback for the lead
    const remaining = await tx.callback.count({
      where: {
        tenantId,
        leadId: cb.leadId,
        status: { in: ["PENDING", "LIVE"] },
        id: { not: callbackId },
      },
    });

    if (remaining === 0) {
      // Restore lead to a pre-CBHOLD neutral status
      await tx.lead.update({
        where: { id: cb.leadId },
        data: { status: "NA", modifyAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        tenantId,
        actorKind: "user",
        actorUserId: BigInt(actor.uid),
        action: "callback.cancelled",
        entityType: "callback",
        entityId: String(callbackId),
        afterJson: { restored_lead: remaining === 0 },
        ts: new Date(),
      },
    });
  });

  callbackCancelledTotal.inc({ actor: "agent" });
  await publishCallbackEvent(redis, {
    type: "callback_cancelled",
    tenantId,
    callbackId,
    leadId: cb.leadId,
    userId: cb.userId,
    ts: new Date().toISOString(),
  });

  return { cancelled: true };
}

// ── Self-claim (GLOBAL → AGENT pin) ──────────────────────────────────────────

export async function claimCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  actor: AuthContext,
  callbackId: bigint,
): Promise<Record<string, unknown>> {
  const tenantId = BigInt(actor.tenantId);

  // CAS: claim only if user_id IS NULL and status is non-terminal
  const result = await prisma.callback.updateMany({
    where: {
      id: callbackId,
      tenantId,
      userId: null,
      status: { in: ["PENDING", "LIVE"] },
    },
    data: { userId: BigInt(actor.uid) },
  });

  if (result.count === 0) {
    // Check why it failed
    const existing = await prisma.callback.findFirst({ where: { id: callbackId, tenantId } });
    if (!existing) throw Object.assign(new Error("callback_not_found"), { statusCode: 404, code: "callback_not_found" });
    if (existing.status === "DONE" || existing.status === "DEAD") {
      throw Object.assign(new Error("callback_terminal"), { statusCode: 409, code: "callback_terminal" });
    }
    // Already claimed by another agent
    claimRaceTotal.inc({ outcome: "lost" });
    throw Object.assign(
      new Error("already_claimed"),
      { statusCode: 409, code: "already_claimed", claimed_by: String(existing.userId) },
    );
  }

  claimRaceTotal.inc({ outcome: "won" });

  const updated = await prisma.callback.findUnique({ where: { id: callbackId } });

  await writeCallbackAudit({
    prisma,
    tenantId,
    callbackId,
    action: "callback.claimed",
    actorKind: "user",
    actorUserId: BigInt(actor.uid),
    detailsJson: { claimed_by: actor.uid },
  });

  await publishCallbackEvent(redis, {
    type: "callback_claimed",
    tenantId,
    callbackId,
    leadId: updated!.leadId,
    userId: BigInt(actor.uid),
    ts: new Date().toISOString(),
  });

  return serializeCallback(updated!);
}

// ── Admin list ────────────────────────────────────────────────────────────────

export async function listCallbacksAdmin(
  prisma: PrismaClient,
  actor: AuthContext,
  filters: {
    statuses?: string[];
    scope?: "GLOBAL" | "AGENT";
    userId?: bigint;
    campaignId?: string;
    dueFrom?: Date;
    dueTo?: Date;
    staleOnly?: boolean;
    cursor?: bigint;
    limit?: number;
  },
): Promise<{ callbacks: Record<string, unknown>[]; next_cursor: string | null }> {
  const tenantId = BigInt(actor.tenantId);
  const limit = filters.limit ?? 50;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    tenantId,
    status: { in: (filters.statuses ?? ["PENDING", "LIVE"]) as ("PENDING" | "LIVE" | "DONE" | "DEAD")[] },
  };

  if (filters.scope === "GLOBAL") where.userId = null;
  else if (filters.scope === "AGENT") where.userId = { not: null };
  if (filters.userId) where.userId = filters.userId;
  if (filters.campaignId) where.campaignId = filters.campaignId;
  if (filters.dueFrom || filters.dueTo) {
    where.callbackAt = {};
    if (filters.dueFrom) where.callbackAt.gte = filters.dueFrom;
    if (filters.dueTo) where.callbackAt.lte = filters.dueTo;
  }
  if (filters.cursor) where.id = { lt: filters.cursor };

  const rows = await prisma.callback.findMany({
    where,
    include: { lead: { select: { knownTimezone: true, firstName: true, lastName: true, phoneE164: true } } },
    orderBy: { callbackAt: "asc" },
    take: limit + 1,
  });

  let results = rows;

  // Stale filter (post-query — stale is computed field based on campaign settings)
  // Phase 1: simple 4h threshold for admin list
  if (filters.staleOnly) {
    const staleThresholdMs = 4 * 3600 * 1000;
    const now = Date.now();
    results = rows.filter((r) => {
      const age = now - r.callbackAt.getTime();
      return r.status === "LIVE" && age > staleThresholdMs;
    });
  }

  const hasMore = results.length > limit;
  if (hasMore) results.pop();
  const nextCursor = hasMore ? String(results[results.length - 1]?.id) : null;

  return { callbacks: results.map(serializeCallback), next_cursor: nextCursor };
}

// ── Admin aggregate ───────────────────────────────────────────────────────────

export async function getCallbackAggregate(
  prisma: PrismaClient,
  actor: AuthContext,
  campaignId?: string,
  horizonHours = 24,
): Promise<Record<string, unknown>> {
  const tenantId = BigInt(actor.tenantId);
  const now = new Date();
  const horizon = new Date(now.getTime() + horizonHours * 3600 * 1000);
  const fiveMinOut = new Date(now.getTime() + 5 * 60 * 1000);
  const staleThreshold = new Date(now.getTime() - 4 * 3600 * 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseWhere: any = { tenantId };
  if (campaignId) baseWhere.campaignId = campaignId;

  const [pending, live, globalScope, agentScope, staleCount, upcoming] = await Promise.all([
    prisma.callback.count({ where: { ...baseWhere, status: "PENDING" } }),
    prisma.callback.count({ where: { ...baseWhere, status: "LIVE" } }),
    prisma.callback.count({ where: { ...baseWhere, status: { in: ["PENDING", "LIVE"] }, userId: null } }),
    prisma.callback.count({ where: { ...baseWhere, status: { in: ["PENDING", "LIVE"] }, userId: { not: null } } }),
    prisma.callback.count({ where: { ...baseWhere, status: "LIVE", callbackAt: { lt: staleThreshold } } }),
    prisma.callback.count({ where: { ...baseWhere, status: "PENDING", callbackAt: { gte: now, lte: fiveMinOut } } }),
  ]);

  // By-hour breakdown
  const byHourRows = await prisma.callback.findMany({
    where: { ...baseWhere, status: "PENDING", callbackAt: { gte: now, lte: horizon } },
    select: { callbackAt: true },
  });

  const byHour: Record<string, number> = {};
  for (const row of byHourRows) {
    const h = new Date(row.callbackAt);
    h.setMinutes(0, 0, 0);
    const key = h.toISOString();
    byHour[key] = (byHour[key] ?? 0) + 1;
  }

  return {
    total_pending: pending,
    total_live: live,
    by_scope: { global: globalScope, agent: agentScope },
    by_hour: Object.entries(byHour).map(([hour_utc, count]) => ({ hour_utc, count })),
    stale_count: staleCount,
    upcoming_5min: upcoming,
  };
}

// ── Admin single-reassign ─────────────────────────────────────────────────────

export async function reassignCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  actor: AuthContext,
  callbackId: bigint,
  body: ReassignBodyType,
): Promise<Record<string, unknown>> {
  const tenantId = BigInt(actor.tenantId);

  if (body.user_id != null) {
    const target = await prisma.user.findFirst({ where: { id: body.user_id, tenantId, active: true } });
    if (!target) throw Object.assign(new Error("user_not_found"), { statusCode: 404, code: "user_not_found" });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const cb = await tx.callback.findFirst({ where: { id: callbackId, tenantId } });
    if (!cb) throw Object.assign(new Error("callback_not_found"), { statusCode: 404, code: "callback_not_found" });

    const u = await tx.callback.update({
      where: { id: callbackId },
      data: { userId: body.user_id },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorKind: "user",
        actorUserId: BigInt(actor.uid),
        action: "callback.reassigned",
        entityType: "callback",
        entityId: String(callbackId),
        afterJson: { to_user_id: body.user_id != null ? String(body.user_id) : null },
        ts: new Date(),
      },
    });

    return u;
  });

  await publishCallbackEvent(redis, {
    type: "callback_reassigned",
    tenantId,
    callbackId,
    leadId: updated.leadId,
    userId: body.user_id,
    ts: new Date().toISOString(),
  });

  return serializeCallback(updated);
}

// ── Bulk reassign ─────────────────────────────────────────────────────────────

export async function bulkReassignCallbacks(
  prisma: PrismaClient,
  actor: AuthContext,
  body: BulkReassignBodyType,
): Promise<{ reassigned: number }> {
  const tenantId = BigInt(actor.tenantId);

  const statusFilter = body.scope === "pending" ? ["PENDING"] : ["PENDING", "LIVE"];

  const result = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.callback.updateMany({
      where: {
        tenantId,
        userId: body.from_user_id,
        status: { in: statusFilter as ["PENDING", "LIVE"] },
      },
      data: { userId: body.to_user_id },
    });

    if (updateResult.count > 0) {
      await tx.auditLog.create({
        data: {
          tenantId,
          actorKind: "user",
          actorUserId: BigInt(actor.uid),
          action: "callback.bulk_reassigned",
          entityType: "callback",
          entityId: "bulk",
          afterJson: {
            from_user_id: String(body.from_user_id),
            to_user_id: body.to_user_id != null ? String(body.to_user_id) : null,
            scope: body.scope,
            count: updateResult.count,
          },
          ts: new Date(),
        },
      });
    }

    return updateResult.count;
  });

  bulkReassignTotal.inc({ outcome: "success" });
  logger.info({ from: String(body.from_user_id), to: String(body.to_user_id), count: result }, "d06:bulk_reassign");

  return { reassigned: result };
}

// ── Bulk cancel ───────────────────────────────────────────────────────────────

export async function bulkCancelCallbacks(
  prisma: PrismaClient,
  actor: AuthContext,
  ids: bigint[],
): Promise<{ cancelled: number }> {
  const tenantId = BigInt(actor.tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const r = await tx.callback.updateMany({
      where: { id: { in: ids }, tenantId, status: { in: ["PENDING", "LIVE"] } },
      data: { status: "DEAD" },
    });

    if (r.count > 0) {
      await tx.auditLog.create({
        data: {
          tenantId,
          actorKind: "user",
          actorUserId: BigInt(actor.uid),
          action: "callback.cancelled",
          entityType: "callback",
          entityId: "bulk",
          afterJson: { ids: ids.map(String), count: r.count },
          ts: new Date(),
        },
      });
    }

    return r.count;
  });

  callbackCancelledTotal.inc({ actor: "supervisor" });
  return { cancelled: result };
}

// ── onNoAnswer — D04 disposition hook ────────────────────────────────────────

export type NoAnswerPolicy = "leave_callbk" | "reschedule_24h" | "terminate_NA";

export async function onNoAnswer(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  tenantId: bigint,
  callbackId: bigint,
  policy: NoAnswerPolicy,
): Promise<void> {
  const cb = await prisma.callback.findFirst({ where: { id: callbackId, tenantId } });
  if (!cb || cb.status !== "LIVE") return;

  if (policy === "leave_callbk") {
    // Default: leave LIVE, agent manually re-schedules
    await writeCallbackAudit({
      prisma, tenantId, callbackId, action: "callback.completed",
      actorKind: "system", detailsJson: { policy: "leave_callbk", outcome: "no_answer" },
    });
    return;
  }

  if (policy === "reschedule_24h") {
    const newAt = new Date(cb.callbackAt.getTime() + 86400 * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.callback.update({
        where: { id: callbackId },
        data: { status: "PENDING", callbackAt: newAt },
      });
      await tx.lead.update({
        where: { id: cb.leadId },
        data: { status: "CBHOLD", modifyAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorKind: "system",
          action: "callback.rescheduled",
          entityType: "callback",
          entityId: String(callbackId),
          afterJson: { policy, new_callback_at: newAt.toISOString() },
          ts: new Date(),
        },
      });
    });

    await publishCallbackEvent(redis, {
      type: "callback_rescheduled",
      tenantId,
      callbackId,
      leadId: cb.leadId,
      userId: cb.userId,
      ts: new Date().toISOString(),
    });
    return;
  }

  if (policy === "terminate_NA") {
    await prisma.$transaction(async (tx) => {
      await tx.callback.update({ where: { id: callbackId }, data: { status: "DONE" } });
      await tx.lead.update({ where: { id: cb.leadId }, data: { status: "NA", modifyAt: new Date() } });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorKind: "system",
          action: "callback.completed",
          entityType: "callback",
          entityId: String(callbackId),
          afterJson: { policy: "terminate_NA" },
          ts: new Date(),
        },
      });
    });

    callbackCompletedTotal.inc({ disposition: "NA" });
  }
}

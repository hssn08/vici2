// I04 — Inbound Callback Queue: service layer.
// fetchQueueForIngroup — supervisor queue snapshot
// createInboundCallback — shared create logic for Path A + Path B
// createStubLead — anonymous caller stub lead
// deferCallback — re-snooze on TCPA SKIP_UNTIL
// onNoAnswerInbound — no-answer policy handler for INBOUND callbacks

import type { PrismaClient } from "@prisma/client";
import { normalizePhone } from "./schemas.js";
import {
  i04CallbackAcceptedTotal,
  i04StubLeadCreatedTotal,
  i04CallbackDeferredTotal,
  i04CallbackDeadTotal,
  i04NoAnswerRescheduleTotal,
  getI04AgeBucket,
  i04CallbackStaleTotal,
} from "./metrics.js";
import pino from "pino";

const logger = pino({ level: "info" });

// ── Phone masking ─────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  if (phone.length <= 3) return "***";
  return phone.slice(0, -3) + "***";
}

// ── Stub lead creation ────────────────────────────────────────────────────────

export async function createStubLead(
  prisma: PrismaClient,
  opts: {
    phone: string;
    tenantId: bigint;
    ingroupId: string;
  },
): Promise<bigint> {
  const lead = await prisma.lead.create({
    data: {
      tenantId: opts.tenantId,
      phone: opts.phone,
      firstName: "Callback",
      lastName: "",
      status: "CALLBK",
      source: "INBOUND_CB",
      modifyAt: new Date(),
    } as Parameters<typeof prisma.lead.create>[0]["data"],
  });

  i04StubLeadCreatedTotal.inc({ ingroup_id: opts.ingroupId });
  logger.info({ tenantId: String(opts.tenantId), phone: maskPhone(opts.phone), ingroupId: opts.ingroupId }, "i04: stub lead created");

  return lead.id;
}

// ── Inbound callback create (shared, Path A + B) ──────────────────────────────

export interface CreateInboundCallbackParams {
  tenantId: bigint;
  ingroupId: string;
  callbackNumber: string;           // normalised
  leadId: bigint;
  originalWaitSeconds: number | null;
  queuePositionAtOffer: number | null;
  comments?: string;
  path: "queue_offer" | "ivr_terminal";
}

export async function createInboundCallback(
  prisma: PrismaClient,
  params: CreateInboundCallbackParams,
): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cb = await (prisma.callback as any).create({
    data: {
      tenantId: params.tenantId,
      leadId: params.leadId,
      // INBOUND callbacks use a sentinel campaign (no campaign context)
      // They are fired by the I01 dispatcher, not a campaign worker.
      campaignId: "__INBOUND_CB__",
      source: "INBOUND",
      originalIngroupId: params.ingroupId,
      originalWaitSeconds: params.originalWaitSeconds,
      callbackNumber: params.callbackNumber,
      callbackAt: new Date(),   // ASAP: NOW()
      status: "PENDING",
      comments: params.comments ?? `Inbound callback request via ${params.path}`,
    },
  });

  // Stamp queue_position_at_offer if provided (uses existing I01 column)
  if (params.queuePositionAtOffer != null) {
    await prisma.$executeRaw`
      UPDATE callbacks
      SET queue_position_at_offer = ${params.queuePositionAtOffer}
      WHERE id = ${cb.id}
    `;
  }

  i04CallbackAcceptedTotal.inc({ path: params.path });
  logger.info(
    {
      tenantId: String(params.tenantId),
      callbackId: String(cb.id),
      ingroupId: params.ingroupId,
      path: params.path,
      waitSeconds: params.originalWaitSeconds,
    },
    "i04: inbound callback created",
  );

  return cb.id;
}

// ── Defer callback on TCPA SKIP_UNTIL ─────────────────────────────────────────

export async function deferCallback(
  prisma: PrismaClient,
  callbackId: bigint,
  tenantId: bigint,
  newCallbackAt: Date,
  ingroupId: string,
): Promise<void> {
  await prisma.callback.update({
    where: { id: callbackId },
    data: { callbackAt: newCallbackAt },
  });

  i04CallbackDeferredTotal.inc({ ingroup_id: ingroupId, reason: "tcpa_skip_until" });
  logger.info({ callbackId: String(callbackId), tenantId: String(tenantId), newCallbackAt: newCallbackAt.toISOString() }, "i04: callback deferred (TCPA)");
}

// ── No-answer policy handler ──────────────────────────────────────────────────

export type InboundNoAnswerPolicy = "leave_callbk" | "reschedule_30m" | "reschedule_24h" | "terminate_NA";

export async function onNoAnswerInbound(
  prisma: PrismaClient,
  callbackId: bigint,
  tenantId: bigint,
  ingroupId: string,
  policy: InboundNoAnswerPolicy,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cb = await (prisma.callback as any).findFirst({
    where: { id: callbackId, tenantId },
  });
  if (!cb || cb.status !== "LIVE") return;

  if (policy === "leave_callbk") {
    // Leave as LIVE — agent manually re-schedules
    logger.info({ callbackId: String(callbackId), policy }, "i04: no-answer leave_callbk");
    i04NoAnswerRescheduleTotal.inc({ ingroup_id: ingroupId, policy });
    return;
  }

  if (policy === "reschedule_30m" || policy === "reschedule_24h") {
    const addMs = policy === "reschedule_30m" ? 30 * 60 * 1000 : 24 * 3600 * 1000;
    const newAt = new Date(Date.now() + addMs);

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
          action: "callback.inbound_no_answer",
          entityType: "callback",
          entityId: String(callbackId),
          afterJson: { policy, new_callback_at: newAt.toISOString(), ingroup_id: ingroupId },
          ts: new Date(),
        },
      });
    });

    i04NoAnswerRescheduleTotal.inc({ ingroup_id: ingroupId, policy });
    logger.info({ callbackId: String(callbackId), policy, newAt: newAt.toISOString() }, "i04: no-answer rescheduled");
    return;
  }

  if (policy === "terminate_NA") {
    await prisma.$transaction(async (tx) => {
      await tx.callback.update({
        where: { id: callbackId },
        data: { status: "DONE" },
      });
      await tx.lead.update({
        where: { id: cb.leadId },
        data: { status: "NA", modifyAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorKind: "system",
          action: "callback.inbound_no_answer",
          entityType: "callback",
          entityId: String(callbackId),
          afterJson: { policy: "terminate_NA", ingroup_id: ingroupId },
          ts: new Date(),
        },
      });
    });

    i04CallbackDeadTotal.inc({ ingroup_id: ingroupId, reason: "no_answer_terminate" });
    logger.info({ callbackId: String(callbackId), policy }, "i04: no-answer terminate_NA");
  }
}

// ── Supervisor queue snapshot ─────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function fetchQueueForIngroup(
  prisma: PrismaClient,
  tenantId: bigint,
  ingroupId: string,
  opts: { limit?: number } = {},
): Promise<{
  ingroup_id: string;
  pending_count: number;
  stale_count: number;
  next_tcpa_window_open: null;
  callbacks: Array<{
    id: string;
    callback_number_masked: string;
    original_wait_seconds: number | null;
    queue_position_at_offer: number | null;
    callback_at: string;
    created_at: string;
    position_priority_active: boolean;
    tcpa_window_open: boolean;
    lead: {
      id: string;
      first_name: string | null;
      last_name: string | null;
      status: string;
    };
  }>;
}> {
  const limit = opts.limit ?? 50;
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);

  // Check ingroup exists
  const ingroup = await prisma.ingroup.findUnique({
    where: { tenantId_id: { tenantId, id: ingroupId } },
    select: { callbackPositionExpiryMinutes: true },
  });

  if (!ingroup) {
    return {
      ingroup_id: ingroupId,
      pending_count: 0,
      stale_count: 0,
      next_tcpa_window_open: null,
      callbacks: [],
    };
  }

  const positionExpiryMs = (ingroup.callbackPositionExpiryMinutes ?? 60) * 60 * 1000;
  const positionExpiryThreshold = new Date(now.getTime() - positionExpiryMs);

  // Count total PENDING INBOUND for this ingroup
   
  const [pendingCount, staleCount, rows] = await Promise.all([
    (prisma.callback as any).count({
      where: {
        tenantId,
        originalIngroupId: ingroupId,
        source: "INBOUND",
        status: "PENDING",
      },
    }),
    (prisma.callback as any).count({
      where: {
        tenantId,
        originalIngroupId: ingroupId,
        source: "INBOUND",
        status: "PENDING",
        createdAt: { lt: staleThreshold },
      },
    }),
    (prisma.callback as any).findMany({
      where: {
        tenantId,
        originalIngroupId: ingroupId,
        source: "INBOUND",
        status: "PENDING",
        callbackAt: { lte: now },
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, status: true } },
      },
      orderBy: [
        { callbackAt: "asc" },
      ],
      take: limit,
    }),
  ]);

  // Emit stale metric
  if (staleCount > 0) {
    i04CallbackStaleTotal.inc({ ingroup_id: ingroupId, age_bucket: getI04AgeBucket((now.getTime() - staleThreshold.getTime()) / 1000) });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callbacks = rows.map((cb: any) => {
    const callbackNum = normalizePhone(cb.callbackNumber ?? "") ?? cb.callbackNumber ?? "";
    const createdAt = new Date(cb.createdAt);
    const positionActive = cb.queuePositionAtOffer != null && createdAt >= positionExpiryThreshold;

    return {
      id: String(cb.id),
      callback_number_masked: maskPhone(callbackNum),
      original_wait_seconds: cb.originalWaitSeconds ?? null,
      queue_position_at_offer: cb.queuePositionAtOffer ?? null,
      callback_at: cb.callbackAt instanceof Date ? cb.callbackAt.toISOString() : String(cb.callbackAt),
      created_at: createdAt.toISOString(),
      position_priority_active: positionActive,
      tcpa_window_open: true,   // Phase 1: always true; C01 wires real gate
      lead: {
        id: String(cb.lead.id),
        first_name: cb.lead.firstName ?? null,
        last_name: cb.lead.lastName ?? null,
        status: cb.lead.status,
      },
    };
  });

  return {
    ingroup_id: ingroupId,
    pending_count: pendingCount,
    stale_count: staleCount,
    next_tcpa_window_open: null,  // Phase 1: null (C01 wires real TCPA window)
    callbacks,
  };
}

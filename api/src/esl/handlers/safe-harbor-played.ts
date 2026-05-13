/**
 * safe-harbor-played.ts — CHANNEL_HANGUP_COMPLETE ESL handler for E05.
 *
 * E05 PLAN §8.4: On every non-bridged live-answered call hangup:
 *   - DROP  (safe_harbor_played=true):  INSERT drop_log + UPDATE call_log in one TX.
 *   - PDROP (safe_harbor_played=false): INSERT drop_log + UPDATE call_log + PAGE operator.
 *
 * MySQL writes are authoritative (TCPA evidence). T01's Lua writes the Valkey
 * STREAM separately; the 60-s reconciler validates agreement.
 *
 * FCC § 64.1200(a)(7): every DROP and PDROP counts in both numerator AND
 * denominator. Playing safe-harbor audio does NOT remove the call from the rate;
 * it satisfies condition (iii). Only a PDROP (no audio) is a per-call violation.
 */

import { PrismaClient, DropReason } from "@prisma/client";

/** Channel variables from FreeSWITCH CHANNEL_HANGUP_COMPLETE event. */
export interface HangupEventVars {
  /** Whether vici2_safe_harbor_played was set to "true" in the dialplan. */
  vici2SafeHarborPlayed?: string;
  /** Whether the call was answered (CHANNEL_ANSWER fired). */
  answered?: string;
  /** Whether the call was bridged to an agent (CHANNEL_BRIDGE fired). */
  bridged?: string;
  /** FreeSWITCH call UUID. */
  callUuid: string;
  /** Campaign ID string (VARCHAR(32)). */
  campaignId: string;
  /** Tenant ID. */
  tenantId: bigint;
  /** Customer E.164 phone number (for drop_log.phone_e164). */
  destNumber: string;
  /** originate_audit.attempt_uuid (T04 one-UUID rule). */
  attemptUuid?: string;
}

export type DropStatus = "DROP" | "PDROP";

/** Result of processing a single CHANNEL_HANGUP_COMPLETE event. */
export interface SafeHarborResult {
  action: "drop_recorded" | "pdrop_recorded" | "skipped";
  status?: DropStatus;
  dropReason?: DropReason;
  safeHarborPlayed: boolean;
}

/**
 * Alert function: severity is "WARN" or "PAGE".
 * Production: wires to PagerDuty / Slack / etc via M08.
 */
export type AlertFn = (
  severity: "WARN" | "PAGE",
  message: string,
  tenantId: bigint,
  campaignId: string
) => void;

/** PDROP deduplication state per campaign (10-minute window). */
const pdropAlertState = new Map<
  string,
  { windowStart: number; count: number }
>();

/**
 * handleSafeHarborPlayed processes a CHANNEL_HANGUP_COMPLETE event.
 *
 * @param prisma  - Prisma client for MySQL writes (TCPA evidence).
 * @param ev      - Channel variables from the ESL event.
 * @param alertFn - Operator notification callback.
 * @returns       SafeHarborResult indicating action taken.
 */
export async function handleSafeHarborPlayed(
  prisma: PrismaClient,
  ev: HangupEventVars,
  alertFn?: AlertFn
): Promise<SafeHarborResult> {
  const answered = ev.answered === "true";
  const bridged = ev.bridged === "true";
  const safeHarborPlayed = ev.vici2SafeHarborPlayed === "true";

  // Only process non-bridged, answered calls.
  if (!answered || bridged) {
    return { action: "skipped", safeHarborPlayed };
  }

  const dropReason = resolveDropReason(ev, safeHarborPlayed);
  const status: DropStatus = safeHarborPlayed ? "DROP" : "PDROP";
  const now = new Date();

  // TCPA evidence: INSERT drop_log + UPDATE call_log in a single MySQL TX.
  await prisma.$transaction(async (tx) => {
    // INSERT drop_log row.
    await tx.dropLog.create({
      data: {
        tenantId: ev.tenantId,
        campaignId: ev.campaignId,
        phoneE164: ev.destNumber,
        droppedAt: now,
        dropReason,
        safeHarborPlayed,
        originatorAttemptUuid: ev.attemptUuid ?? null,
      },
    });

    // UPDATE call_log: mark is_drop=true + status.
    // call_log is identified by the call_uuid (FreeSWITCH UUID).
    await tx.callLog.updateMany({
      where: {
        tenantId: ev.tenantId,
        callUuid: ev.callUuid,
      },
      data: {
        isDrop: true,
        status,
      },
    });
  });

  // PDROP: PAGE operator (deduplication: 1 page per campaign per 10 min).
  if (!safeHarborPlayed) {
    maybePdropAlert(alertFn, ev.tenantId, ev.campaignId, ev.callUuid, dropReason);
    return { action: "pdrop_recorded", status, dropReason, safeHarborPlayed };
  }

  return { action: "drop_recorded", status, dropReason, safeHarborPlayed };
}

/**
 * resolveDropReason maps channel vars to the appropriate DropReason enum value.
 * E05 PLAN §8.5.
 */
function resolveDropReason(
  ev: HangupEventVars,
  safeHarborPlayed: boolean
): DropReason {
  if (!safeHarborPlayed) {
    // Audio not played: check why.
    if (ev.vici2SafeHarborPlayed === undefined) {
      // Channel var never set — could be customer early hangup or audio missing.
      // Default: audio_missing (conservative — triggers PAGE).
      return DropReason.audio_missing;
    }
    return DropReason.customer_hangup_early;
  }
  // Audio played: standard no-agent drop.
  return DropReason.no_agent;
}

/**
 * maybePdropAlert pages the operator at most once per campaign per 10 minutes.
 * Underlying counter always increments (via Prometheus in Go tier).
 * E05 PLAN §7, AC-05.
 */
function maybePdropAlert(
  alertFn: AlertFn | undefined,
  tenantId: bigint,
  campaignId: string,
  callUuid: string,
  dropReason: DropReason
): void {
  if (!alertFn) return;

  const key = `${tenantId}:${campaignId}`;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes

  const state = pdropAlertState.get(key);
  if (!state || now - state.windowStart > windowMs) {
    // New window: send alert.
    pdropAlertState.set(key, { windowStart: now, count: 1 });
    alertFn(
      "PAGE",
      `PDROP: campaign ${campaignId} call ${callUuid} safe_harbor NOT played ` +
        `(reason=${dropReason}) — per-call § 64.1200(a)(7) violation`,
      tenantId,
      campaignId
    );
  } else {
    // Within window: increment only (suppress duplicate page).
    state.count++;
  }
}

/** resetPdropAlertState clears dedup state for a campaign (for tests). */
export function resetPdropAlertState(campaignKey: string): void {
  pdropAlertState.delete(campaignKey);
}

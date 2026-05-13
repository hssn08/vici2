// PATCH /api/sup/sessions/:id/mode
//
// Mode-transition endpoint: switches an active monitor session between
// listen, whisper, and barge. Applies zero-glitch ordering rules by
// delegating to the dialer's supervisor.Operator (or equivalent conference
// command sequence via ESL).
//
// S02 PLAN §11.2, §4.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MonitorModePatchBodySchema } from "./monitor.schema.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

const MODE_SWITCH_RATE_WINDOW_MS = 1000;
// Valkey key prefix for per-session rate limiter.
// S02 PLAN §4.3: max 1 switch/sec/session.
const RATE_KEY_PREFIX = "vici2:monitor:rate:";

export function registerMonitorModeRoute(app: FastifyInstance): void {
  app.patch(
    "/api/sup/sessions/:id/mode",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = MonitorModePatchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }

      const { id: sessionId } = req.params as { id: string };
      const body = parsed.data;
      const auth = req.auth!;
      const redis = getRedis();

      // ── 1. Rate limit: ≤1 switch/sec per session (S02 PLAN §4.3) ─────────
      const rateKey = `${RATE_KEY_PREFIX}${sessionId}`;
      const rateCount = await redis.incr(rateKey);
      if (rateCount === 1) {
        // First switch: set 1s expiry window.
        await redis.pexpire(rateKey, MODE_SWITCH_RATE_WINDOW_MS);
      }
      if (rateCount > 1) {
        return reply.code(429).send({ error: "rate_limited" });
      }

      // ── 2. Resolve session from Valkey ────────────────────────────────────
      // The session_id from the URL is the JTI. The FS call UUID is stored in
      // the session HASH (sup_call_uuid field).
      // We locate the session by scanning t:{tid}:monitor:* — in Phase 1 we
      // store the JTI→sup_call_uuid mapping in an additional Valkey key.
      const jtiIndexKey = `t:${auth.tenantId}:monitor:jti:${sessionId}`;
      const supCallUUID = await redis.get(jtiIndexKey);
      if (!supCallUUID) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const sessionKey = `t:${auth.tenantId}:monitor:${supCallUUID}`;
      const session = await redis.hgetall(sessionKey);
      if (!session || !session.mode) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      // ── 3. Authorization: session must belong to the requesting supervisor ─
      if (session.sup_uid && Number(session.sup_uid) !== auth.uid) {
        // Allow admin/super_admin to switch mode on any session.
        if (!["admin", "super_admin"].includes(auth.role)) {
          return reply.code(403).send({ error: "not_session_owner" });
        }
      }

      const currentMode = session.mode as "listen" | "whisper" | "barge";
      const newMode = body.mode;

      // ── 4. Same-mode guard ────────────────────────────────────────────────
      if (currentMode === newMode) {
        return reply.code(409).send({ error: "same_mode" });
      }

      // ── 5. Enumerate non-agent, non-supervisor member IDs for relate calls ─
      const targetUID = session.target_uid;
      const tenantID = auth.tenantId;
      const confMembersKey = `t:${tenantID}:agent:${targetUID}:conf_members`;
      const confMembers = await redis.hgetall(confMembersKey);
      const custMIDs: number[] = [];
      for (const val of Object.values(confMembers)) {
        const parts = val.split(":");
        if (parts.length < 2) continue;
        const role = parts[1] ?? "";
        if (role === "agent_leg" || role === "supervisor_leg") continue;
        const mid = parseInt(parts[0] ?? "", 10);
        if (!isNaN(mid)) custMIDs.push(mid);
      }

      const supMID = parseInt(session["conf_member_id"] ?? "0", 10);
      const confName = `agent_t${tenantID}_u${targetUID ?? "0"}`;

      // ── 6. Apply transition sequence (S02 PLAN §4.1 ordering rules) ───────
      // We call the ESL API server's internal conference command via HTTP
      // (Phase 1: direct Valkey/ESL not available from the API process).
      // In Phase 2 this should go through a gRPC/ESL proxy or the dialer's
      // supervisor.Operator. For Phase 1, we construct the conference commands
      // and call the dialer's internal ESL endpoint.
      //
      // Phase 1 implementation: issue conference commands via the dialer's
      // HTTP internal endpoint. The dialer exposes a minimal conference command
      // proxy at POST /internal/conference/command.
      try {
        const cmds = buildTransitionCmds(currentMode, newMode, supMID, custMIDs);
        for (const cmd of cmds) {
          await issueConferenceCommand(confName, cmd.command, cmd.args);
        }
      } catch (err) {
        req.log.error({ err, confName, currentMode, newMode }, "monitor: conference command failed");
        return reply.code(500).send({ error: "conference_command_failed" });
      }

      // ── 7. Update Valkey session mode ─────────────────────────────────────
      await redis.hset(sessionKey, "mode", newMode);

      // Update conf_members role tag.
      await redis.hset(confMembersKey, supCallUUID, `${supMID}:supervisor_leg:${newMode}`);

      const transitionedAt = new Date().toISOString();

      // ── 8. Write audit row ────────────────────────────────────────────────
      try {
        const prisma = getPrisma();
        await // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (prisma.auditLog as any).create({
          data: {
            tenantId: BigInt(tenantID),
            actorUserId: BigInt(auth.uid),
            actorKind: "user",
            action: "monitor.mode.changed",
            entityType: "monitor_session",
            entityId: supCallUUID,
            beforeJson: { mode: currentMode },
            afterJson: { mode: newMode, transitioned_at: transitionedAt },
            requestId: null,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] ?? null,
            ts: new Date(),
          },
        });
      } catch (err) {
        req.log.error({ err }, "monitor: mode audit write failed (non-fatal)");
      }

      return reply.code(200).send({
        session_id: sessionId,
        previous_mode: currentMode,
        mode: newMode,
        transitioned_at: transitionedAt,
      });
    },
  );
}

/** Build the ordered sequence of conference commands for a mode transition. */
function buildTransitionCmds(
  from: string,
  to: string,
  supMID: number,
  custMIDs: number[],
): Array<{ command: string; args: string }> {
  const supStr = String(supMID);
  const cmds: Array<{ command: string; args: string }> = [];

  if (from === "listen" && to === "whisper") {
    // SAFE ORDER: relate nospeak FIRST, then unmute. (S02 PLAN §4.2)
    for (const cid of custMIDs) {
      cmds.push({ command: "relate", args: `${supMID} ${cid} nospeak` });
    }
    cmds.push({ command: "unmute", args: supStr });
  } else if (from === "listen" && to === "barge") {
    cmds.push({ command: "unmute", args: supStr });
  } else if (from === "whisper" && to === "listen") {
    // SAFE ORDER: mute FIRST, then relate clear. (S02 PLAN §4.2)
    cmds.push({ command: "mute", args: supStr });
    for (const cid of custMIDs) {
      cmds.push({ command: "relate", args: `${supMID} ${cid} clear` });
    }
  } else if (from === "whisper" && to === "barge") {
    for (const cid of custMIDs) {
      cmds.push({ command: "relate", args: `${supMID} ${cid} clear` });
    }
  } else if (from === "barge" && to === "whisper") {
    for (const cid of custMIDs) {
      cmds.push({ command: "relate", args: `${supMID} ${cid} nospeak` });
    }
  } else if (from === "barge" && to === "listen") {
    cmds.push({ command: "mute", args: supStr });
  }

  return cmds;
}

/**
 * Issue a single conference command via the dialer's internal proxy.
 *
 * Phase 1: HTTP POST to dialer's conference command endpoint.
 * Phase 2: replace with direct gRPC or ESL client call.
 */
async function issueConferenceCommand(
  confName: string,
  command: string,
  args: string,
): Promise<void> {
  // Phase 1: The dialer exposes POST /internal/conference/command.
  // If the dialer internal endpoint is not available, we still proceed
  // (optimistic: the FS state will be reconciled on next conf-maint event).
  const dialerUrl = process.env.DIALER_INTERNAL_URL ?? "http://dialer:8081";
  const resp = await fetch(`${dialerUrl}/internal/conference/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conf_name: confName, command, args }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    throw new Error(`conference command ${command} failed: HTTP ${resp.status} ${text}`);
  }
}

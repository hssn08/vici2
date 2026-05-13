// I05 — VM Drop Audit Consumer
// Reads events:vici2.audit.vmdrop Valkey stream (written by Go AMDHandler on
// vmdrop_played / vmdrop_blocked_no_asset / vmdrop_blocked_consent) and writes
// rows to the audit_log table.
//
// Also reads events:vici2.audit.voicemail for voicemail_captured / voicemail_partial
// events emitted by voicemail-hooks.ts.
//
// Consumer group: "api-vmdrop-audit"
// Consumer ID: "api-{pid}"

import pino from "pino";
import { getPrisma } from "../lib/prisma.js";
import { getRedis } from "../lib/redis.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "i05-vmdrop-audit" },
});

const prisma = getPrisma();
const VMDROP_STREAM = "events:vici2.audit.vmdrop";
const VM_STREAM = "events:vici2.audit.voicemail";
const GROUP_NAME = "api-vmdrop-audit";
const CONSUMER_ID = `api-${process.pid}`;
const BLOCK_MS = 5000;
const BATCH_SIZE = 20;

// ─── Payload shapes ───────────────────────────────────────────────────────────

interface VMDropPayload {
  action: string;
  entity_type: string;
  entity_id: string;
  tenant_id: string;
  call_uuid?: string;
  lead_id?: string;
  vm_drop_path?: string;
}

interface VoicemailAuditPayload {
  action: string;
  entity_type: string;
  entity_id: string;
  tenant_id: string;
  call_uuid?: string;
  voicemail_id?: string;
  duration_sec?: string;
  partial?: string;
}

type AuditPayload = VMDropPayload | VoicemailAuditPayload;

// ─── Write audit row ──────────────────────────────────────────────────────────

async function writeAuditRow(payload: AuditPayload): Promise<void> {
  const tenantId = BigInt(payload.tenant_id ?? "1");
  const entityId = payload.entity_id ?? "0";

  // Build afterJson from relevant fields
  const afterJson: Record<string, string> = {};
  if ("call_uuid" in payload && payload.call_uuid) afterJson.call_uuid = payload.call_uuid;
  if ("lead_id" in payload && payload.lead_id) afterJson.lead_id = payload.lead_id;
  if ("vm_drop_path" in payload && payload.vm_drop_path) afterJson.vm_drop_path = payload.vm_drop_path;
  if ("voicemail_id" in payload && payload.voicemail_id) afterJson.voicemail_id = payload.voicemail_id;
  if ("duration_sec" in payload && payload.duration_sec) afterJson.duration_sec = payload.duration_sec;
  if ("partial" in payload && payload.partial) afterJson.partial = payload.partial;

  await prisma.auditLog.create({
    data: {
      tenantId,
      actorUserId: null, // system action
      actorKind: "system",
      action: payload.action,
      entityType: payload.entity_type,
      entityId,
      afterJson,
      ts: new Date(),
    },
  });
}

// ─── Stream consumer ──────────────────────────────────────────────────────────

async function consumeStream(stream: string): Promise<void> {
  const redis = getRedis();

  // Create consumer group (idempotent)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (redis as any).xgroup("CREATE", stream, GROUP_NAME, "0", "MKSTREAM");
  } catch {
    // Group may already exist — ignore BUSYGROUP error
  }

  let running = true;

  const shutdown = (): void => {
    running = false;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info({ stream, group: GROUP_NAME, consumer: CONSUMER_ID }, "i05: audit consumer started");

  while (running) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = await (redis as any).xreadgroup(
        "GROUP", GROUP_NAME, CONSUMER_ID,
        "COUNT", BATCH_SIZE,
        "BLOCK", BLOCK_MS,
        "STREAMS", stream, ">",
      );

      if (!entries) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const [, messages] of entries as any[]) {
        for (const [msgId, fields] of messages as [string, string[]][]) {
          try {
            // fields is a flat array: [key, value, key, value, ...]
            const obj: Record<string, string> = {};
            const fieldsArr: string[] = fields ?? [];
            for (let i = 0; i + 1 < fieldsArr.length; i += 2) {
              obj[fieldsArr[i] as string] = fieldsArr[i + 1] as string;
            }

            if (obj["data"]) {
              const payload = JSON.parse(obj["data"]) as AuditPayload;
              await writeAuditRow(payload);
            }

            // ACK the message
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (redis as any).xack(stream, GROUP_NAME, msgId);
          } catch (err) {
            logger.error({ err, msgId, stream }, "i05: failed to process audit message");
            // Do not ACK — will be retried on next XAUTOCLAIM or restart
          }
        }
      }
    } catch (err) {
      if (!running) break;
      logger.error({ err, stream }, "i05: XREADGROUP error");
      // Brief pause before retry
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
  }

  logger.info({ stream }, "i05: audit consumer stopped");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function startVmdropAuditConsumer(): Promise<void> {
  // Run both stream consumers concurrently
  await Promise.all([
    consumeStream(VMDROP_STREAM),
    consumeStream(VM_STREAM),
  ]);
}

// Allow running as standalone worker
if (import.meta.url === `file://${process.argv[1]}`) {
  startVmdropAuditConsumer().catch((err: unknown) => {
    logger.error({ err }, "i05: audit consumer fatal error");
    process.exit(1);
  });
}

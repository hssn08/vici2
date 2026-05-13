// D05 — Federal DNC daily delta sync worker (PLAN §3.2).
// Cron: 0 3 * * *  (03:00 UTC)
// Dev mode: DNC_FEDERAL_DRY_RUN=true → loads seeds/dnc-federal-test.csv

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;
import { FederalSoapClient, type FederalSoapConfig } from "./federal-soap-client.js";
import { parseDeltaLine } from "./federal-soap-schema.js";
import { bloomMadd } from "../bloom.js";

const LOCK_KEY = "t:0:dnc:fed:sync:lock";
const LOCK_TTL = 3600; // seconds
const BATCH_SIZE = 5000;
const BLOOM_BATCH = 100_000;

export interface FederalDeltaSyncResult {
  added: number;
  removed: number;
  skipped: string;
}

/** Run the daily federal delta sync.  Returns early if lock taken. */
export async function runFederalDeltaSync(
  redis: AnyRedis,
  prisma: AnyPrisma,
  cfg: FederalSoapConfig,
  opts: { dryRun?: boolean; seedFile?: string } = {},
): Promise<FederalDeltaSyncResult | null> {
  // Acquire distributed lock
  const lockId = `${process.pid}-${Date.now()}`;
   
  const acquired = await redis.set(LOCK_KEY, lockId, "NX", "EX", LOCK_TTL);
  if (!acquired) return null; // another instance running

  let sessionToken: string | null = null;
  let added = 0;
  let removed = 0;
  let skipped = "";

  try {
    let filePath: string;

    if (opts.dryRun) {
      // Dev mode: use seed file
      filePath = opts.seedFile ?? join(process.cwd(), "db/seeds/dnc-federal-test.csv");
    } else {
      // Production: SOAP download
      const client = new FederalSoapClient(cfg);
      sessionToken = await client.logIn();

      const status = await client.canGetChangeFile(sessionToken);
      if (status === "AlreadyDownloadedToday" || status === "NoChanges") {
        skipped = status;
        return { added: 0, removed: 0, skipped };
      }
      if (status === "RequestPending") {
        // Poll with 30s backoff up to 10 min
        let waited = 0;
        while (waited < 600) {
          await delay(30_000);
          waited += 30;
          const s2 = await client.canGetChangeFile(sessionToken);
          if (s2 === "RequestCompleted") break;
          if (s2 !== "RequestPending") throw new Error(`Unexpected status: ${s2}`);
        }
      }

      const presignedUrl = await client.getChangeFile(sessionToken);
      const tmpFile = join(tmpdir(), `dnc-fed-delta-${Date.now()}.txt`);
      await downloadFile(presignedUrl, tmpFile);
      filePath = tmpFile;
    }

    // Parse and apply in batches
    const addBatch: string[] = [];
    const delBatch: string[] = [];
    const bloomAdds: string[] = [];

    const processAdd = async (phones: string[]) => {
      if (phones.length === 0) return;
      const values = phones.map(
        (p) => `(0, '${p}', 'federal', '__', '__GLOBAL__', NOW(), NOW())`,
      );
      await prisma.$executeRawUnsafe(
        `INSERT IGNORE INTO dnc (tenant_id, phone_e164, source, state, campaign_id, created_at, updated_at)
         VALUES ${values.join(",")}`,
      );
      added += phones.length;
    };

    const processDel = async (phones: string[]) => {
      if (phones.length === 0) return;
      const placeholders = phones.map(() => "?").join(",");
      await prisma.$executeRawUnsafe(
        `UPDATE dnc SET expires_at = NOW(), updated_at = NOW()
         WHERE tenant_id = 0
           AND source = 'federal'
           AND phone_e164 IN (${placeholders})`,
        ...phones,
      );
      removed += phones.length;
    };

    const processBloomAdds = async (phones: string[]) => {
      if (phones.length === 0) return;
      await bloomMadd(redis, "federal", undefined, phones);
    };

    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = parseDeltaLine(line);
      if (!parsed) continue;

      const e164 = `+1${parsed.phone10}`;
      if (parsed.action === "A") {
        addBatch.push(e164);
        bloomAdds.push(e164);
        if (addBatch.length >= BATCH_SIZE) {
          await processAdd([...addBatch]);
          addBatch.length = 0;
        }
        if (bloomAdds.length >= BLOOM_BATCH) {
          await processBloomAdds([...bloomAdds]);
          bloomAdds.length = 0;
        }
      } else {
        delBatch.push(e164);
        if (delBatch.length >= BATCH_SIZE) {
          await processDel([...delBatch]);
          delBatch.length = 0;
        }
      }
    }

    // Flush remaining
    await processAdd(addBatch);
    await processDel(delBatch);
    await processBloomAdds(bloomAdds);

    if (!opts.dryRun && sessionToken) {
      const client = new FederalSoapClient(cfg);
      await client.logOut(sessionToken);
      sessionToken = null;
    }

    // Log sync result in dnc_sync_log
    await prisma.$executeRawUnsafe(
      `INSERT INTO dnc_sync_log (source, kind, outcome, added_count, removed_count, started_at, completed_at)
       VALUES ('federal', 'delta', 'success', ?, ?, NOW() - INTERVAL 1 SECOND, NOW())`,
      added,
      removed,
    );

    return { added, removed, skipped };
  } catch (err) {
    if (!opts.dryRun && sessionToken) {
      const client = new FederalSoapClient(cfg);
      try { await client.logOut(sessionToken); } catch { /* ignore */ }
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO dnc_sync_log (source, kind, outcome, error_message, started_at, completed_at)
       VALUES ('federal', 'delta', 'failed', ?, NOW() - INTERVAL 1 SECOND, NOW())`,
      (err as Error).message?.slice(0, 1000) ?? "unknown",
    ).catch(() => { /* ignore log failure */ });
    throw err;
  } finally {
    // Release lock only if we hold it
    const val = await redis.get(LOCK_KEY);
    if (val === lockId) await redis.del(LOCK_KEY);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const out = createWriteStream(dest);
  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    out,
  );
}

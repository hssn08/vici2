// D05 — Internal DNC bulk import (PLAN §6.4).
// Accepts a CSV buffer (max 5000 rows), parses, normalises, inserts + Bloom-adds.

import { parsePhoneNumberFromString } from "libphonenumber-js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;
import { bloomMadd } from "./bloom.js";

const CHUNK_SIZE = 1000;

export interface BulkImportResult {
  added: number;
  rejected: number;
}

interface BulkRow {
  phone: string;
  notes?: string;
  campaignId?: string;
  state?: string;
}

function parsePhone(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), "US");
  if (!parsed || !parsed.isValid()) return null;
  return parsed.format("E.164");
}

/**
 * Parse CSV lines from buffer.
 * Expected columns: phone[, notes][, campaign_id][, state]
 * First line is treated as header and skipped if it matches that pattern.
 */
function parseCsvRows(csvText: string): BulkRow[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: BulkRow[] = [];

  let start = 0;
  // Skip header if present
  if (lines[0] && /^phone/i.test(lines[0])) start = 1;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const cols = line.split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
    if (!cols[0]) continue;
    rows.push({
      phone: cols[0],
      notes: cols[1] || undefined,
      campaignId: cols[2] || undefined,
      state: cols[3] || undefined,
    });
  }
  return rows;
}

export async function bulkImportDnc(
  redis: AnyRedis,
  prisma: AnyPrisma,
  opts: {
    tenantId: number;
    source: "internal" | "state" | "litigator";
    csvText: string;
    addedByUserId?: number;
    defaultNotes?: string;
    campaignId?: string;
    state?: string;
  },
): Promise<BulkImportResult> {
  const rawRows = parseCsvRows(opts.csvText);
  const maxRows = 5000;
  const rows = rawRows.slice(0, maxRows);

  let added = 0;
  let rejected = rawRows.length > maxRows ? rawRows.length - maxRows : 0;

  // Determine tenant_id for storage
  const dbTenantId = opts.source === "internal" ? opts.tenantId : 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const valid: Array<{ phone: string; campaign_id: string; state: string; notes: string }> = [];

    for (const row of chunk) {
      const phone = parsePhone(row.phone ?? "");
      if (!phone) { rejected++; continue; }
      valid.push({
        phone,
        campaign_id: row.campaignId ?? opts.campaignId ?? "__GLOBAL__",
        state: row.state ?? opts.state ?? "__",
        notes: row.notes ?? opts.defaultNotes ?? "",
      });
    }

    if (valid.length === 0) continue;

    // Batch INSERT IGNORE
    const values = valid
      .map((r) =>
        `(${dbTenantId}, '${r.phone.replace(/'/g, "''")}', '${opts.source}', '${r.state}', '${r.campaign_id}', NOW(), ${opts.addedByUserId ?? "NULL"}, '${r.notes.replace(/'/g, "''")}', NOW(), NOW())`,
      )
      .join(",");

    await prisma.$executeRawUnsafe(
      `INSERT IGNORE INTO dnc
         (tenant_id, phone_e164, source, state, campaign_id, added_at, added_by, notes, created_at, updated_at)
       VALUES ${values}`,
    );
    added += valid.length;

    // Bloom add
    const phones = valid.map((r) => r.phone);
    if (opts.source === "internal") {
      await bloomMadd(redis, "internal", opts.tenantId, phones);
    } else if (opts.source === "state") {
      await bloomMadd(redis, "state", opts.tenantId, phones);
    } else if (opts.source === "litigator") {
      await bloomMadd(redis, "litigator", undefined, phones);
    }
  }

  return { added, rejected };
}

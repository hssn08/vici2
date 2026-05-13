// D02 — Column mapping utilities (workers copy, duplicates api/src/import/mapping/)
// This duplication is intentional: workers cannot import from api package.

import { parse as dateFnsParse, isValid as isDateValid } from "date-fns";
import type { ColumnMapping, MappingRow } from "./types.js";

/** Apply a single transform chain to a raw string value. */
export function applyTransforms(
  value: string,
  transformStr: string | undefined,
  allFields?: Record<string, string>,
): string {
  if (!transformStr) return value;
  let v = value;
  const transforms = splitTransforms(transformStr);

  for (const t of transforms) {
    if (t === "trim") {
      v = v.trim();
    } else if (t === "lower") {
      v = v.toLowerCase();
    } else if (t === "upper") {
      v = v.toUpperCase();
    } else if (t === "nullify_blank") {
      v = v.trim() === "" ? "" : v;
    } else if (t === "parseInt") {
      const n = parseInt(v, 10);
      v = isNaN(n) ? v : String(n);
    } else if (t === "parseFloat") {
      const n = parseFloat(v);
      v = isNaN(n) ? v : String(n);
    } else if (t === "phone") {
      v = v.trim();
    } else if (t.startsWith("date:")) {
      const fmt = t.slice(5);
      const parsed = dateFnsParse(v.trim(), fmt, new Date(0));
      if (isDateValid(parsed)) {
        v = parsed.toISOString().split("T")[0]!;
      }
    } else if (t.startsWith("map:")) {
      const pairs = t.slice(4).split(";");
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx < 0) continue;
        const k = pair.slice(0, eqIdx);
        const val = pair.slice(eqIdx + 1);
        if (v === k) { v = val; break; }
      }
    } else if (t.startsWith("concat:")) {
      const colName = t.slice(7);
      const otherVal = allFields?.[colName] ?? "";
      v = v + otherVal;
    }
  }
  return v;
}

function splitTransforms(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (ch === ",") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function applyMapping(
  record: string[],
  headerRow: string[],
  mapping: ColumnMapping,
): Record<string, string> {
  const sourceIndex = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    sourceIndex.set(headerRow[i]!, i);
    sourceIndex.set(headerRow[i]!.toLowerCase(), i);
  }

  const rawByTarget: Record<string, string> = {};
  for (const row of mapping.rows) {
    const idx = sourceIndex.get(row.source) ?? sourceIndex.get(row.source.toLowerCase());
    if (idx === undefined) continue;
    rawByTarget[row.target] = record[idx] ?? "";
  }

  const result: Record<string, string> = {};
  for (const row of mapping.rows) {
    const raw = rawByTarget[row.target] ?? "";
    result[row.target] = applyTransforms(raw, row.transform, rawByTarget);
  }
  return result;
}

export function validateMapping(m: unknown): ColumnMapping {
  if (typeof m !== "object" || m === null) {
    throw new Error("Column mapping must be a JSON object");
  }
  const obj = m as Record<string, unknown>;
  if (obj["version"] !== 1) throw new Error("Column mapping version must be 1");
  if (!Array.isArray(obj["rows"])) throw new Error("Column mapping.rows must be an array");

  const rows: MappingRow[] = [];
  for (const r of obj["rows"] as unknown[]) {
    if (typeof r !== "object" || r === null) throw new Error("Each mapping row must be an object");
    const row = r as Record<string, unknown>;
    if (typeof row["source"] !== "string") throw new Error("mapping row.source must be a string");
    if (typeof row["target"] !== "string") throw new Error("mapping row.target must be a string");
    rows.push({
      source: row["source"] as string,
      target: row["target"] as string,
      transform: typeof row["transform"] === "string" ? row["transform"] : undefined,
    });
  }
  return { version: 1, rows, options: obj["options"] as ColumnMapping["options"] };
}

export const VICIDIAL_DEFAULT_MAPPING: MappingRow[] = [
  { source: "phone_number",     target: "phone_e164",       transform: "phone" },
  { source: "first_name",       target: "first_name",        transform: "trim" },
  { source: "last_name",        target: "last_name",         transform: "trim" },
  { source: "state",            target: "state",             transform: "trim,upper" },
  { source: "postal_code",      target: "postal_code",       transform: "trim" },
  { source: "vendor_lead_code", target: "vendor_lead_code",  transform: "trim" },
  { source: "source_id",        target: "source_id",         transform: "trim" },
  { source: "address1",         target: "address1",          transform: "trim" },
  { source: "address2",         target: "address2",          transform: "trim" },
  { source: "city",             target: "city",              transform: "trim" },
  { source: "email",            target: "email",             transform: "lower" },
  { source: "gender",           target: "gender",            transform: "upper" },
  { source: "date_of_birth",    target: "date_of_birth",     transform: "date:MM/dd/yyyy" },
  { source: "comments",         target: "comments",          transform: "trim" },
];

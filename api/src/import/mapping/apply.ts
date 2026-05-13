// D02 — Column mapping apply + transform functions (PLAN §7.1)

import { parse as dateFnsParse, isValid as isDateValid } from "date-fns";
import type { ColumnMapping, MappingRow } from "../../../../workers/src/jobs/lead-import/types.js";

export class MappingTransformError extends Error {
  constructor(
    public readonly field: string,
    public readonly transform: string,
    public readonly raw: string,
    msg: string,
  ) {
    super(msg);
    this.name = "MappingTransformError";
  }
}

/** Apply a single transform chain to a raw string value. */
export function applyTransforms(
  value: string,
  transformStr: string | undefined,
  allFields?: Record<string, string>,
): string {
  if (!transformStr) return value;

  let v = value;
  // Split on commas but not inside map/concat args
  const transforms = splitTransforms(transformStr);

  for (const t of transforms) {
    if (t === "trim") {
      v = v.trim();
    } else if (t === "lower") {
      v = v.toLowerCase();
    } else if (t === "upper") {
      v = v.toUpperCase();
    } else if (t === "nullify_blank") {
      v = v.trim() === "" ? "" : v;  // return "" for blank; upstream code handles null conversion
    } else if (t === "parseInt") {
      const n = parseInt(v, 10);
      v = isNaN(n) ? v : String(n);
    } else if (t === "parseFloat") {
      const n = parseFloat(v);
      v = isNaN(n) ? v : String(n);
    } else if (t === "phone") {
      // Phone normalization handled separately by normalize-validate stage
      v = v.trim();
    } else if (t.startsWith("date:")) {
      const fmt = t.slice(5);
      const parsed = dateFnsParse(v.trim(), fmt, new Date(0));
      if (!isDateValid(parsed)) {
        // Return original if parse fails; normalize-validate will catch it
        // (v is already the original value; no assignment needed)
      } else {
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
    // Unknown transforms are silently ignored (forward-compat)
  }

  return v;
}

/** Split comma-separated transforms, respecting map:k=v;k2=v2 and concat:col */
function splitTransforms(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;

  for (const ch of s) {
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
      if (ch === ":") depth++;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Apply column mapping to a raw record array, using header row for column names.
 * Returns a Record<target, value> for all mapped columns.
 */
export function applyMapping(
  record: string[],
  headerRow: string[],
  mapping: ColumnMapping,
): Record<string, string> {
  // Build source→index map
  const sourceIndex = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    sourceIndex.set(headerRow[i]!.toLowerCase(), i);
    sourceIndex.set(headerRow[i]!, i);
  }

  // First pass: gather raw values
  const rawByTarget: Record<string, string> = {};
  for (const row of mapping.rows) {
    const idx = sourceIndex.get(row.source) ?? sourceIndex.get(row.source.toLowerCase());
    if (idx === undefined) continue;
    rawByTarget[row.target] = record[idx] ?? "";
  }

  // Second pass: apply transforms (with concat access to raw fields)
  const result: Record<string, string> = {};
  for (const row of mapping.rows) {
    const raw = rawByTarget[row.target] ?? "";
    result[row.target] = applyTransforms(raw, row.transform, rawByTarget);
  }

  return result;
}

/** Apply mapping when there is no header row — use positional mapping. */
export function applyPositionalMapping(
  record: string[],
  mapping: ColumnMapping,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < mapping.rows.length; i++) {
    const row = mapping.rows[i]!;
    const raw = record[i] ?? "";
    result[row.target] = applyTransforms(raw, row.transform);
  }
  return result;
}

/** Validate a mapping object. */
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

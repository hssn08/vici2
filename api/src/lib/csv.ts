// Shared CSV serialisation utility.
//
// Produces RFC 4180 CSV with a UTF-8 BOM (for Excel compatibility).
// Null values are serialised as empty cells.
// Numbers are unquoted. Strings containing commas/quotes/newlines are quoted.

const BOM = "﻿";

function escapeCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert an array of objects to a RFC 4180 CSV string with BOM.
 *
 * @param headers  Column names (used as the first row and as object keys).
 * @param rows     Array of objects; only keys present in `headers` are included.
 */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const headerRow = headers.map(escapeCell).join(",");
  const dataRows = rows.map((row) =>
    headers.map((h) => escapeCell(row[h])).join(","),
  );
  return BOM + [headerRow, ...dataRows].join("\r\n");
}

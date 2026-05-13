// D01 — Cursor pagination (PLAN §2)
// cursor = base64url( JSON({ v: 1, k: [ <modify_at ISO8601>, <id> ] }) )

export const CURSOR_VERSION = 1;

export type SortOrder = "modify_at_desc" | "created_at_desc";

export interface CursorPayload {
  v: number;
  k: [string, string]; // [timestamp_iso, id_str]
  sort: SortOrder;
}

export interface DecodedCursor {
  timestamp: Date;
  id: bigint;
  sort: SortOrder;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

export function encodeCursor(ts: Date, id: bigint, sort: SortOrder): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    k: [ts.toISOString(), id.toString()],
    sort,
  };
  return b64urlEncode(JSON.stringify(payload));
}

export class CursorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CursorError";
    this.code = code;
  }
}

export function decodeCursor(raw: string, expectedSort: SortOrder): DecodedCursor {
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(raw));
  } catch {
    throw new CursorError("INVALID_CURSOR", "Cursor is not valid base64url JSON");
  }

  if (typeof payload !== "object" || payload === null) {
    throw new CursorError("INVALID_CURSOR", "Cursor payload is not an object");
  }

  const p = payload as Record<string, unknown>;

  if (p["v"] !== CURSOR_VERSION) {
    throw new CursorError(
      "INVALID_CURSOR_VERSION",
      `Cursor version mismatch: expected ${CURSOR_VERSION}, got ${p["v"]}`,
    );
  }

  if (!Array.isArray(p["k"]) || p["k"].length !== 2) {
    throw new CursorError("INVALID_CURSOR", "Cursor k field must be a 2-element array");
  }

  const [tsRaw, idRaw] = p["k"] as unknown[];

  if (typeof tsRaw !== "string" || typeof idRaw !== "string") {
    throw new CursorError("INVALID_CURSOR", "Cursor k elements must be strings");
  }

  if (typeof p["sort"] !== "string") {
    throw new CursorError("INVALID_CURSOR", "Cursor sort field missing");
  }

  if (p["sort"] !== expectedSort) {
    throw new CursorError(
      "CURSOR_SORT_MISMATCH",
      `Cursor sort "${p["sort"]}" does not match requested sort "${expectedSort}"`,
    );
  }

  const ts = new Date(tsRaw);
  if (isNaN(ts.getTime())) {
    throw new CursorError("INVALID_CURSOR", "Cursor timestamp is not a valid ISO8601 string");
  }

  let id: bigint;
  try {
    id = BigInt(idRaw);
  } catch {
    throw new CursorError("INVALID_CURSOR", "Cursor id is not a valid integer");
  }

  return { timestamp: ts, id, sort: p["sort"] as SortOrder };
}

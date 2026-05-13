// D01 — cursor.ts unit tests

import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, CursorError } from "../../src/leads/cursor.js";

describe("cursor encode/decode", () => {
  const ts = new Date("2026-05-06T14:21:55.123456Z");
  const id = 1742030n;

  it("round-trips modify_at_desc cursor", () => {
    const encoded = encodeCursor(ts, id, "modify_at_desc");
    const decoded = decodeCursor(encoded, "modify_at_desc");
    expect(decoded.timestamp.toISOString()).toBe(ts.toISOString());
    expect(decoded.id).toBe(id);
    expect(decoded.sort).toBe("modify_at_desc");
  });

  it("round-trips created_at_desc cursor", () => {
    const encoded = encodeCursor(ts, id, "created_at_desc");
    const decoded = decodeCursor(encoded, "created_at_desc");
    expect(decoded.sort).toBe("created_at_desc");
  });

  it("throws CURSOR_SORT_MISMATCH when sort doesn't match", () => {
    const encoded = encodeCursor(ts, id, "modify_at_desc");
    expect(() => decodeCursor(encoded, "created_at_desc")).toThrow(CursorError);
    try {
      decodeCursor(encoded, "created_at_desc");
    } catch (err) {
      expect((err as CursorError).code).toBe("CURSOR_SORT_MISMATCH");
    }
  });

  it("throws INVALID_CURSOR for tampered base64", () => {
    expect(() => decodeCursor("totally-not-valid!!", "modify_at_desc")).toThrow(CursorError);
  });

  it("throws INVALID_CURSOR for invalid JSON", () => {
    const bad = Buffer.from("not json").toString("base64url");
    expect(() => decodeCursor(bad, "modify_at_desc")).toThrow(CursorError);
  });

  it("throws INVALID_CURSOR_VERSION for wrong version", () => {
    const badPayload = { v: 999, k: [ts.toISOString(), String(id)], sort: "modify_at_desc" };
    const encoded = Buffer.from(JSON.stringify(badPayload)).toString("base64url");
    try {
      decodeCursor(encoded, "modify_at_desc");
    } catch (err) {
      expect((err as CursorError).code).toBe("INVALID_CURSOR_VERSION");
    }
  });

  it("throws INVALID_CURSOR for non-object payload", () => {
    const encoded = Buffer.from('"just-a-string"').toString("base64url");
    expect(() => decodeCursor(encoded, "modify_at_desc")).toThrow(CursorError);
  });

  it("throws INVALID_CURSOR for missing k field", () => {
    const badPayload = { v: 1, sort: "modify_at_desc" };
    const encoded = Buffer.from(JSON.stringify(badPayload)).toString("base64url");
    expect(() => decodeCursor(encoded, "modify_at_desc")).toThrow(CursorError);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkLength,
  checkPassword,
  isPwned,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  setHibpFetcherForTests,
} from "../../src/auth/password-policy.js";

describe("password-policy", () => {
  beforeEach(() => {
    process.env.HIBP_OFFLINE = "false";
  });
  afterEach(() => {
    setHibpFetcherForTests(null);
    process.env.HIBP_OFFLINE = "true";
  });

  it("rejects too short", () => {
    expect(checkLength("abc").ok).toBe(false);
    expect(checkLength("a".repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
  });

  it("accepts ≥12 chars", () => {
    expect(checkLength("a".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it("rejects too long", () => {
    expect(checkLength("a".repeat(MAX_PASSWORD_LENGTH + 1)).ok).toBe(false);
  });

  it("isPwned returns true when HIBP suffix matches", async () => {
    setHibpFetcherForTests(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        // suffix of SHA1("password123!") starts with FCB9E... — we just craft a known matching suffix.
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\n0000000000000000000000000000000000:9",
    }));
    // SHA1("hunter2hunter2") sample — we just stub the response so the test
    // matches a contrived suffix. Compute the suffix for the given password.
    const { createHash } = await import("node:crypto");
    const sha1 = createHash("sha1").update("hunter2hunter2").digest("hex").toUpperCase();
    const suffix = sha1.slice(5);
    setHibpFetcherForTests(async () => ({
      ok: true,
      status: 200,
      text: async () => `${suffix}:42\n0000000000000000000000000000000000:9`,
    }));
    expect(await isPwned("hunter2hunter2")).toBe(true);
  });

  it("isPwned returns false when no suffix matches", async () => {
    setHibpFetcherForTests(async () => ({
      ok: true,
      status: 200,
      text: async () => "0000000000000000000000000000000000:9",
    }));
    expect(await isPwned("a-completely-unique-passphrase-1234")).toBe(false);
  });

  it("fails open on HIBP outage", async () => {
    setHibpFetcherForTests(async () => {
      throw new Error("network down");
    });
    expect(await isPwned("whatever-password")).toBe(false);
  });

  it("checkPassword composes length + HIBP", async () => {
    setHibpFetcherForTests(async () => ({
      ok: true,
      status: 200,
      text: async () => "0000000000000000000000000000000000:9",
    }));
    const res = await checkPassword("good-strong-passphrase-here-1!");
    expect(res.ok).toBe(true);
  });
});

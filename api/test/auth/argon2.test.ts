import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARAMS,
  hashPassword,
  needsRehash,
  parsePhcParams,
  setArgon2Params,
  verifyPassword,
} from "../../src/auth/argon2.js";

describe("argon2", () => {
  it("round-trips a hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const hash = await hashPassword("hello-world-123");
    expect(await verifyPassword("nope", hash)).toBe(false);
  });

  it("emits unique hashes for the same input (random salt)", async () => {
    const a = await hashPassword("same-password-here");
    const b = await hashPassword("same-password-here");
    expect(a).not.toEqual(b);
    expect(await verifyPassword("same-password-here", a)).toBe(true);
    expect(await verifyPassword("same-password-here", b)).toBe(true);
  });

  it("parses PHC params from encoded hashes", async () => {
    const hash = await hashPassword("abc-with-params");
    const p = parsePhcParams(hash);
    expect(p).not.toBeNull();
    expect(p!.memoryCost).toBe(DEFAULT_PARAMS.memoryCost);
    expect(p!.timeCost).toBe(DEFAULT_PARAMS.timeCost);
    expect(p!.parallelism).toBe(DEFAULT_PARAMS.parallelism);
  });

  it("flags rehash when stored params are below current", async () => {
    setArgon2Params({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const hash = await hashPassword("rehash-me-please");
    expect(needsRehash(hash)).toBe(false);
    setArgon2Params({ memoryCost: 32768, timeCost: 3, parallelism: 1 });
    expect(needsRehash(hash)).toBe(true);
    setArgon2Params(DEFAULT_PARAMS);
  });

  it("returns false on malformed hash", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

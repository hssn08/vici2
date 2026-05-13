import { describe, expect, it } from "vitest";

import {
  decryptSipPassword,
  encryptSipPassword,
  generateSipPassword,
  generateSipUsername,
} from "../../src/auth/sip-creds.js";

describe("sip-creds", () => {
  it("generates a password of the requested length", () => {
    const pw = generateSipPassword(32);
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("encrypts and decrypts a sip password", () => {
    const ident = { rowId: 42n, tenantId: 1n };
    const pw = generateSipPassword();
    const { ciphertextBlob } = encryptSipPassword(pw, ident);
    const out = decryptSipPassword(ciphertextBlob, ident);
    expect(out).toBe(pw);
  });

  it("rejects decryption with mismatched row_id (AAD swap)", () => {
    const pw = "supersecret";
    const enc = encryptSipPassword(pw, { rowId: 1n, tenantId: 1n });
    expect(() => decryptSipPassword(enc.ciphertextBlob, { rowId: 2n, tenantId: 1n })).toThrow();
  });

  it("generates conventional sip usernames", () => {
    expect(generateSipUsername(42)).toBe("sip_42");
  });
});

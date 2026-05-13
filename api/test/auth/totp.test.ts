import { describe, expect, it } from "vitest";

import {
  decryptTotpSecret,
  encryptTotpSecret,
  enrollTotp,
  generateBackupCodes,
  generateOtpForTests,
  verifyTotpCode,
} from "../../src/auth/totp.js";

describe("totp", () => {
  it("enroll produces an otpauth URI with the issuer and user", () => {
    const r = enrollTotp({ user: "alice@example.com", issuer: "vici2" });
    expect(r.secret.length).toBeGreaterThanOrEqual(32);
    expect(r.secret).toMatch(/^[A-Z2-7]+$/);
    expect(r.otpauthUri).toContain("otpauth://totp/");
    expect(r.otpauthUri).toContain("vici2");
    expect(r.otpauthUri).toContain(encodeURIComponent("alice@example.com"));
  });

  it("verifies a code generated from the same secret", () => {
    const { secret } = enrollTotp({ user: "u", issuer: "i" });
    const code = generateOtpForTests(secret);
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects a code from a different secret", () => {
    const a = enrollTotp({ user: "a", issuer: "i" });
    const b = enrollTotp({ user: "b", issuer: "i" });
    const code = generateOtpForTests(a.secret);
    expect(verifyTotpCode(b.secret, code)).toBe(false);
  });

  it("encrypts and decrypts the totp secret with envelope", () => {
    const { secret } = enrollTotp({ user: "u", issuer: "i" });
    const blob = encryptTotpSecret(secret, { userId: 5n, tenantId: 1n });
    expect(decryptTotpSecret(blob, { userId: 5n, tenantId: 1n })).toBe(secret);
  });

  it("generates 10 backup codes by default", () => {
    const c = generateBackupCodes();
    expect(c.plain).toHaveLength(10);
    for (const code of c.plain) {
      expect(code).toMatch(/^[0-9A-F-]+$/);
    }
  });
});

import { describe, expect, it } from "vitest";

import { decrypt, decryptToString, encrypt } from "../../src/auth/encryption.js";

describe("encryption envelope", () => {
  it("round-trips a string with matching AAD", () => {
    const ident = { table: "sip_credentials", column: "sip_password_ct", rowId: 42n, tenantId: 1n };
    const { ciphertextBlob, kekVersion } = encrypt({ ...ident, plaintext: "p@ssw0rd!" });
    expect(kekVersion).toBe(1);
    const out = decryptToString({ ...ident, ciphertextBlob });
    expect(out).toBe("p@ssw0rd!");
  });

  it("rejects when AAD parts are swapped (row_id)", () => {
    const a = encrypt({
      table: "sip_credentials",
      column: "sip_password_ct",
      rowId: 1n,
      tenantId: 1n,
      plaintext: "alpha",
    });
    expect(() =>
      decrypt({
        table: "sip_credentials",
        column: "sip_password_ct",
        rowId: 2n,
        tenantId: 1n,
        ciphertextBlob: a.ciphertextBlob,
      }),
    ).toThrow();
  });

  it("rejects when tenant_id is wrong", () => {
    const a = encrypt({
      table: "sip_credentials",
      column: "sip_password_ct",
      rowId: 1n,
      tenantId: 1n,
      plaintext: "alpha",
    });
    expect(() =>
      decrypt({
        table: "sip_credentials",
        column: "sip_password_ct",
        rowId: 1n,
        tenantId: 999n,
        ciphertextBlob: a.ciphertextBlob,
      }),
    ).toThrow();
  });

  it("rejects when column changes", () => {
    const a = encrypt({
      table: "sip_credentials",
      column: "sip_password_ct",
      rowId: 1n,
      tenantId: 1n,
      plaintext: "alpha",
    });
    expect(() =>
      decrypt({
        table: "sip_credentials",
        column: "other_ct",
        rowId: 1n,
        tenantId: 1n,
        ciphertextBlob: a.ciphertextBlob,
      }),
    ).toThrow();
  });

  it("rejects truncated blob", () => {
    const a = encrypt({
      table: "x",
      column: "y",
      rowId: 1n,
      tenantId: 1n,
      plaintext: "abc",
    });
    const trimmed = a.ciphertextBlob.slice(0, 30);
    expect(() =>
      decrypt({ table: "x", column: "y", rowId: 1n, tenantId: 1n, ciphertextBlob: trimmed }),
    ).toThrow();
  });

  it("packs the blob with version 0x01 in byte 0", () => {
    const a = encrypt({
      table: "sip_credentials",
      column: "sip_password_ct",
      rowId: 7n,
      tenantId: 1n,
      plaintext: "x",
    });
    expect(a.ciphertextBlob[0]).toBe(0x01);
    expect(Buffer.from(a.ciphertextBlob).readUInt16LE(1)).toBe(1);
  });

  it("fits a 32-char sip password inside VARBINARY(512)", () => {
    const a = encrypt({
      table: "sip_credentials",
      column: "sip_password_ct",
      rowId: 1n,
      tenantId: 1n,
      plaintext: "a".repeat(32),
    });
    expect(a.ciphertextBlob.length).toBeLessThanOrEqual(512);
  });
});

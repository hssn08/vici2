// TOTP enrollment + verification (PLAN §10).
// Per PLAN: TOTP secret is stored encrypted via the AES-GCM envelope helper.
// F02 schema has `users.totp_required`; the actual `user_totp_secrets` row
// model is deferred to F06. Until then, secrets are kept transient in-memory
// or in an external store passed by the caller. F05 ships the primitives so
// F06 plugs in without re-migration.

import { authenticator } from "otplib";
import { randomBytes } from "node:crypto";

import { encrypt, decryptToString } from "./encryption.js";

authenticator.options = {
  step: 30,
  window: 1,
  digits: 6,
};

export interface EnrollmentResult {
  secret: string;
  otpauthUri: string;
}

export function enrollTotp(opts: { user: string; issuer?: string }): EnrollmentResult {
  const secret = authenticator.generateSecret(32);
  const otpauthUri = authenticator.keyuri(opts.user, opts.issuer ?? "vici2", secret);
  return { secret, otpauthUri };
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

export interface BackupCodes {
  plain: string[];
  hashes: string[];
}

export function generateBackupCodes(count = 10): BackupCodes {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const buf = randomBytes(5);
    const code = buf.toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-");
    plain.push(code);
  }
  return { plain, hashes };
}

export interface SecretIdentity {
  userId: bigint | number;
  tenantId: bigint | number;
}

export function encryptTotpSecret(secret: string, ident: SecretIdentity): Uint8Array {
  return encrypt({
    table: "user_totp_secrets",
    column: "secret_ct",
    rowId: ident.userId,
    tenantId: ident.tenantId,
    plaintext: secret,
  }).ciphertextBlob;
}

export function decryptTotpSecret(blob: Uint8Array, ident: SecretIdentity): string {
  return decryptToString({
    table: "user_totp_secrets",
    column: "secret_ct",
    rowId: ident.userId,
    tenantId: ident.tenantId,
    ciphertextBlob: blob,
  });
}

export function generateOtpForTests(secret: string): string {
  return authenticator.generate(secret);
}

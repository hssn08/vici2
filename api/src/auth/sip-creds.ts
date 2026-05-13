// SIP credential generation + encryption/decryption (PLAN §5).

import { randomBytes } from "node:crypto";

import { encrypt, decryptToString } from "./encryption.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateSipPassword(length = 32): string {
  const buf = randomBytes(length * 2);
  let out = "";
  let i = 0;
  while (out.length < length && i < buf.length) {
    const b = buf[i++]!;
    if (b < 248) out += ALPHABET[b % ALPHABET.length];
  }
  if (out.length < length) {
    return out + generateSipPassword(length - out.length);
  }
  return out;
}

export function generateSipUsername(userId: number): string {
  return `sip_${userId}`;
}

export interface SipBlobIdentity {
  rowId: bigint | number;
  tenantId: bigint | number;
}

export function encryptSipPassword(
  password: string,
  ident: SipBlobIdentity,
): { ciphertextBlob: Uint8Array; kekVersion: number } {
  return encrypt({
    table: "sip_credentials",
    column: "sip_password_ct",
    rowId: ident.rowId,
    tenantId: ident.tenantId,
    plaintext: password,
  });
}

export function decryptSipPassword(
  blob: Uint8Array,
  ident: SipBlobIdentity,
): string {
  return decryptToString({
    table: "sip_credentials",
    column: "sip_password_ct",
    rowId: ident.rowId,
    tenantId: ident.tenantId,
    ciphertextBlob: blob,
  });
}

// AES-GCM-256 envelope encryption (PLAN §4).
//
// Blob layout (FROZEN):
//   offset  bytes  field
//   0       1      version_byte (0x01)
//   1       2      kek_version (u16 LE)
//   3       12     dek_wrap_iv
//   15      32     dek_wrap_ct      (AES-256-GCM(KEK, DEK))
//   47      16     dek_wrap_tag
//   63      12     payload_iv
//   75      N      payload_ct       (AES-256-GCM(DEK, plaintext, AAD))
//   75+N    16     payload_tag
//
// AAD = SHA-256("table:<t>:column:<c>:row_id:<r>:tenant_id:<tid>:kek_version:<v>")

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

import { env, kekVersionEnv } from "../lib/env.js";

const LAYOUT_VERSION = 0x01;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const HEADER_BYTES = 1 + 2 + IV_BYTES + DEK_BYTES + TAG_BYTES + IV_BYTES;

export interface EncryptParams {
  table: string;
  column: string;
  rowId: bigint | number;
  tenantId: bigint | number;
  plaintext: string | Uint8Array;
}

export interface DecryptParams {
  table: string;
  column: string;
  rowId: bigint | number;
  tenantId: bigint | number;
  ciphertextBlob: Uint8Array;
}

export interface EncryptResult {
  ciphertextBlob: Uint8Array;
  kekVersion: number;
}

function getKek(version: number): Buffer {
  const b64 = kekVersionEnv(version);
  if (!b64) throw new Error(`KEK version ${version} not configured`);
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) throw new Error(`KEK v${version} must be 32 bytes; got ${buf.length}`);
  return buf;
}

function payloadAad(p: {
  table: string;
  column: string;
  rowId: bigint | number;
  tenantId: bigint | number;
  kekVersion: number;
}): Buffer {
  const s = `table:${p.table}:column:${p.column}:row_id:${p.rowId.toString()}:tenant_id:${p.tenantId.toString()}:kek_version:${p.kekVersion}`;
  return createHash("sha256").update(s).digest();
}

function kekAad(version: number): Buffer {
  return Buffer.from(`vici2:kek-wrap:v${version}`, "utf-8");
}

let _randomBytes: (n: number) => Buffer = (n) => randomBytes(n);
export function setRandomBytesForTests(fn: ((n: number) => Buffer) | null): void {
  _randomBytes = fn ?? ((n) => randomBytes(n));
}

export function encrypt(p: EncryptParams): EncryptResult {
  const kekVersion = env.kekCurrentVersion;
  const kek = getKek(kekVersion);
  const dek = _randomBytes(DEK_BYTES);
  const dekWrapIv = _randomBytes(IV_BYTES);
  const payloadIv = _randomBytes(IV_BYTES);

  const dekWrap = createCipheriv("aes-256-gcm", kek, dekWrapIv) as CipherGCM;
  dekWrap.setAAD(kekAad(kekVersion));
  const dekCt = Buffer.concat([dekWrap.update(dek), dekWrap.final()]);
  const dekTag = dekWrap.getAuthTag();

  const aad = payloadAad({ ...p, kekVersion });
  const cipher = createCipheriv("aes-256-gcm", dek, payloadIv) as CipherGCM;
  cipher.setAAD(aad);
  const plaintextBuf =
    typeof p.plaintext === "string" ? Buffer.from(p.plaintext, "utf-8") : Buffer.from(p.plaintext);
  const payloadCt = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const payloadTag = cipher.getAuthTag();

  const out = Buffer.alloc(HEADER_BYTES + payloadCt.length + TAG_BYTES);
  let off = 0;
  out.writeUInt8(LAYOUT_VERSION, off); off += 1;
  out.writeUInt16LE(kekVersion, off); off += 2;
  dekWrapIv.copy(out, off); off += IV_BYTES;
  dekCt.copy(out, off); off += DEK_BYTES;
  dekTag.copy(out, off); off += TAG_BYTES;
  payloadIv.copy(out, off); off += IV_BYTES;
  payloadCt.copy(out, off); off += payloadCt.length;
  payloadTag.copy(out, off);

  return { ciphertextBlob: out, kekVersion };
}

export function decrypt(p: DecryptParams): Buffer {
  const blob = Buffer.from(p.ciphertextBlob);
  if (blob.length < HEADER_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  let off = 0;
  const version = blob.readUInt8(off); off += 1;
  if (version !== LAYOUT_VERSION) throw new Error(`unsupported blob version ${version}`);
  const kekVersion = blob.readUInt16LE(off); off += 2;
  if (kekVersion < 1) throw new Error("invalid kek_version");
  const kek = getKek(kekVersion);
  const dekWrapIv = blob.subarray(off, off + IV_BYTES); off += IV_BYTES;
  const dekCt = blob.subarray(off, off + DEK_BYTES); off += DEK_BYTES;
  const dekTag = blob.subarray(off, off + TAG_BYTES); off += TAG_BYTES;
  const payloadIv = blob.subarray(off, off + IV_BYTES); off += IV_BYTES;
  const payloadCt = blob.subarray(off, blob.length - TAG_BYTES);
  const payloadTag = blob.subarray(blob.length - TAG_BYTES);

  const dekUnwrap = createDecipheriv("aes-256-gcm", kek, dekWrapIv) as DecipherGCM;
  dekUnwrap.setAAD(kekAad(kekVersion));
  dekUnwrap.setAuthTag(dekTag);
  const dek = Buffer.concat([dekUnwrap.update(dekCt), dekUnwrap.final()]);

  const aad = payloadAad({ ...p, kekVersion });
  const decipher = createDecipheriv("aes-256-gcm", dek, payloadIv) as DecipherGCM;
  decipher.setAAD(aad);
  decipher.setAuthTag(payloadTag);
  return Buffer.concat([decipher.update(payloadCt), decipher.final()]);
}

export function decryptToString(p: DecryptParams): string {
  return decrypt(p).toString("utf-8");
}

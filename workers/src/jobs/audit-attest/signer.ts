/**
 * workers/src/jobs/audit-attest/signer.ts
 *
 * Ed25519 signing interface (PLAN §5.4).
 * Phase 1: reads VICI2_AUDIT_SIGNING_KEY from environment (base64url DER or PEM).
 * Phase 4: backed by HashiCorp Vault Transit via F05 integration.
 *
 * The signing key is DISTINCT from the JWT signing key (F05).
 * Key ID format: ed25519-audit-<year>-<seq> (e.g. ed25519-audit-2026-1).
 */

import { createPrivateKey, createPublicKey, createSign } from 'node:crypto';

export interface SignerInterface {
  sign(message: string): Buffer;
  keyId(): string;
  publicKeyPem(): string;
}

export class EnvSigner implements SignerInterface {
  private readonly key: ReturnType<typeof createPrivateKey>;
  private readonly _keyId: string;
  private readonly _pubPem: string;

  constructor() {
    const rawKey = process.env.VICI2_AUDIT_SIGNING_KEY;
    if (!rawKey) {
      throw new Error(
        'VICI2_AUDIT_SIGNING_KEY is not set. This is required for audit attestation signing.',
      );
    }
    const keyIdEnv = process.env.VICI2_AUDIT_SIGNING_KEY_ID;
    if (!keyIdEnv) {
      throw new Error('VICI2_AUDIT_SIGNING_KEY_ID is not set.');
    }
    this._keyId = keyIdEnv;

    // Accept both PEM and base64-encoded DER
    let pem = rawKey;
    if (!rawKey.startsWith('-----')) {
      // Assume base64-encoded DER; convert to PEM
      const der = Buffer.from(rawKey, 'base64');
      pem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----`;
    }

    this.key = createPrivateKey(pem);

    // Derive public key PEM for publishing
    const pubKey = createPublicKey(this.key);
    this._pubPem = pubKey.export({ type: 'spki', format: 'pem' }) as string;
  }

  sign(message: string): Buffer {
    const signer = createSign('Ed25519');
    signer.update(message);
    return signer.sign(this.key);
  }

  keyId(): string {
    return this._keyId;
  }

  publicKeyPem(): string {
    return this._pubPem;
  }
}

/** No-op signer for tests that do not test signature verification. */
export class NullSigner implements SignerInterface {
  private static readonly FAKE_SIG = Buffer.alloc(64, 0xde);

  sign(_message: string): Buffer {
    return NullSigner.FAKE_SIG;
  }

  keyId(): string {
    return 'test-null-signer';
  }

  publicKeyPem(): string {
    return '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----';
  }
}

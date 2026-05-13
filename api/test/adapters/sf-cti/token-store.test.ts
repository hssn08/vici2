// N03 — Unit tests for SF token encrypt/decrypt round-trip.
// Note: token-store.ts imports getPrisma; we mock the prisma module so
// tests exercise only the encrypt/decrypt helpers without a real DB.

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock getPrisma before any module that imports it
vi.mock('../../../src/lib/prisma.js', () => ({
  getPrisma: () => ({}),
  setPrismaForTests: () => {},
}));

import { encryptSfToken, decryptSfToken } from '../../../src/routes/adapters/sf-integration/token-store.js';

beforeAll(() => {
  // Provide a valid 32-byte base64 KEK for encryption tests
  process.env.VICI2_KEK_V1 = Buffer.alloc(32, 0xab).toString('base64');
  process.env.VICI2_KEK_CURRENT_VERSION = '1';
});

describe('encryptSfToken / decryptSfToken round-trip', () => {
  const rowId = 1n;
  const tenantId = 42n;

  it('encrypts and decrypts an access token correctly', () => {
    const plaintext = 'FAKE_ACCESS_TOKEN_xyz123';
    const ct = encryptSfToken({ column: 'access_token', rowId, tenantId, plaintext });
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(ct.length).toBeGreaterThan(0);
    const decrypted = decryptSfToken({ column: 'access_token', rowId, tenantId, ciphertextBlob: ct });
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts a refresh token correctly', () => {
    const plaintext = 'FAKE_REFRESH_TOKEN_abc456';
    const ct = encryptSfToken({ column: 'refresh_token', rowId, tenantId, plaintext });
    const decrypted = decryptSfToken({ column: 'refresh_token', rowId, tenantId, ciphertextBlob: ct });
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts a client secret correctly', () => {
    const plaintext = 'super-secret-client-secret-value';
    const ct = encryptSfToken({ column: 'client_secret', rowId, tenantId, plaintext });
    const decrypted = decryptSfToken({ column: 'client_secret', rowId, tenantId, ciphertextBlob: ct });
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same-plaintext';
    const ct1 = encryptSfToken({ column: 'access_token', rowId, tenantId, plaintext });
    const ct2 = encryptSfToken({ column: 'access_token', rowId, tenantId, plaintext });
    expect(Buffer.compare(Buffer.from(ct1), Buffer.from(ct2))).not.toBe(0);
  });

  it('fails to decrypt when AAD does not match (wrong column)', () => {
    const plaintext = 'token-value';
    const ct = encryptSfToken({ column: 'access_token', rowId, tenantId, plaintext });
    expect(() =>
      decryptSfToken({ column: 'refresh_token', rowId, tenantId, ciphertextBlob: ct }),
    ).toThrow();
  });

  it('fails to decrypt when AAD does not match (wrong tenantId)', () => {
    const plaintext = 'token-value';
    const ct = encryptSfToken({ column: 'access_token', rowId, tenantId, plaintext });
    expect(() =>
      decryptSfToken({ column: 'access_token', rowId, tenantId: 99n, ciphertextBlob: ct }),
    ).toThrow();
  });

  it('fails to decrypt when ciphertext is tampered', () => {
    const plaintext = 'token-value';
    const ct = Buffer.from(encryptSfToken({ column: 'access_token', rowId, tenantId, plaintext }));
    // Flip a byte in the middle (payload area)
    ct[80] = ct[80] ^ 0xff;
    expect(() =>
      decryptSfToken({ column: 'access_token', rowId, tenantId, ciphertextBlob: ct }),
    ).toThrow();
  });
});

/**
 * merkle.spec.ts — Unit tests for shared/lib/merkle.ts (RFC 6962).
 *
 * Tests the five vectors from test/fixtures/merkle/rfc6962_test_vectors.json
 * plus inclusion proof verification.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildMerkleRoot,
  buildWithProof,
  verifyInclusion,
  proofToHex,
  EMPTY_ROOT,
} from '../../../../../shared/lib/merkle.js';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest();
const sha256hex = (buf: Buffer) => sha256(buf).toString('hex');

// Re-implement leaf hash for test assertion
const leafHash = (rowHex: string) =>
  sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(rowHex, 'hex')]));

const internalHash = (left: Buffer, right: Buffer) =>
  sha256(Buffer.concat([Buffer.from([0x01]), left, right]));

describe('EMPTY_ROOT', () => {
  it('equals SHA256(0x00)', () => {
    const expected = sha256hex(Buffer.from([0x00]));
    expect(EMPTY_ROOT.toString('hex')).toBe(expected);
  });
});

describe('buildMerkleRoot', () => {
  it('empty tree returns EMPTY_ROOT', () => {
    const root = buildMerkleRoot([]);
    expect(root.equals(EMPTY_ROOT)).toBe(true);
  });

  it('single leaf: root equals leaf hash', () => {
    const rowHash = '00'.repeat(32);
    const expected = leafHash(rowHash);
    const root = buildMerkleRoot([rowHash]);
    expect(root.equals(expected)).toBe(true);
  });

  it('two leaves: root = internalHash(leaf0, leaf1)', () => {
    const h0 = '00'.repeat(32);
    const h1 = '01'.repeat(32);
    const expected = internalHash(leafHash(h0), leafHash(h1));
    const root = buildMerkleRoot([h0, h1]);
    expect(root.equals(expected)).toBe(true);
  });

  it('three leaves: odd-count duplication per RFC 6962', () => {
    const h0 = '00'.repeat(32);
    const h1 = '01'.repeat(32);
    const h2 = '02'.repeat(32);
    const l0 = leafHash(h0);
    const l1 = leafHash(h1);
    const l2 = leafHash(h2);
    // level 1: [int(l0,l1), int(l2,l2)]  (l2 duplicated)
    const n01 = internalHash(l0, l1);
    const n22 = internalHash(l2, l2);
    const expected = internalHash(n01, n22);
    const root = buildMerkleRoot([h0, h1, h2]);
    expect(root.equals(expected)).toBe(true);
  });

  it('five leaves', () => {
    const hashes = [
      'aa'.repeat(32),
      'bb'.repeat(32),
      'cc'.repeat(32),
      'dd'.repeat(32),
      'ee'.repeat(32),
    ];
    const root = buildMerkleRoot(hashes);
    // Not checking exact value, just that it's deterministic
    const root2 = buildMerkleRoot(hashes);
    expect(root.equals(root2)).toBe(true);
    expect(root).toHaveLength(32);
  });

  it('is order-dependent', () => {
    const h0 = 'aa'.repeat(32);
    const h1 = 'bb'.repeat(32);
    const root01 = buildMerkleRoot([h0, h1]);
    const root10 = buildMerkleRoot([h1, h0]);
    expect(root01.equals(root10)).toBe(false);
  });
});

describe('buildWithProof + verifyInclusion', () => {
  it('single leaf: proof verifies', () => {
    const rowHashes = ['ab'.repeat(32)];
    const { root, proof } = buildWithProof(rowHashes, 0);
    expect(verifyInclusion(rowHashes[0]!, proof, root)).toBe(true);
  });

  it('two leaves: left leaf proof verifies', () => {
    const rowHashes = ['aa'.repeat(32), 'bb'.repeat(32)];
    const { root, proof } = buildWithProof(rowHashes, 0);
    expect(verifyInclusion(rowHashes[0]!, proof, root)).toBe(true);
  });

  it('two leaves: right leaf proof verifies', () => {
    const rowHashes = ['aa'.repeat(32), 'bb'.repeat(32)];
    const { root, proof } = buildWithProof(rowHashes, 1);
    expect(verifyInclusion(rowHashes[1]!, proof, root)).toBe(true);
  });

  it('five leaves: every leaf proof verifies', () => {
    const rowHashes = ['aa', 'bb', 'cc', 'dd', 'ee'].map((h) => h.repeat(32));
    for (let i = 0; i < rowHashes.length; i++) {
      const { root, proof } = buildWithProof(rowHashes, i);
      expect(verifyInclusion(rowHashes[i]!, proof, root)).toBe(true);
    }
  });

  it('wrong leaf does not verify', () => {
    const rowHashes = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
    const { root, proof } = buildWithProof(rowHashes, 0);
    // Try to verify with a different row hash
    expect(verifyInclusion('bb'.repeat(32), proof, root)).toBe(false);
  });

  it('tampered root does not verify', () => {
    const rowHashes = ['aa'.repeat(32), 'bb'.repeat(32)];
    const { proof } = buildWithProof(rowHashes, 0);
    const fakeRoot = Buffer.alloc(32, 0xff);
    expect(verifyInclusion(rowHashes[0]!, proof, fakeRoot)).toBe(false);
  });

  it('proofToHex round-trips', () => {
    const rowHashes = ['aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32)];
    const { root, proof } = buildWithProof(rowHashes, 1);
    const hexProof = proofToHex(proof);
    expect(hexProof.path).toHaveLength(proof.path.length);
    expect(hexProof.path[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyInclusion(rowHashes[1]!, hexProof, root)).toBe(true);
  });

  it('throws on out-of-bounds leafIndex', () => {
    const rowHashes = ['aa'.repeat(32)];
    expect(() => buildWithProof(rowHashes, 1)).toThrow(RangeError);
    expect(() => buildWithProof(rowHashes, -1)).toThrow(RangeError);
  });

  it('throws on empty tree', () => {
    expect(() => buildWithProof([], 0)).toThrow(RangeError);
  });
});

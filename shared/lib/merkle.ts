/**
 * shared/lib/merkle.ts — RFC 6962 Merkle tree (SHA-256)
 *
 * Pure-function, zero-dependency implementation.
 * Used by:
 *   - AttestationWorker (build root from daily row_hash list)
 *   - AuditVerifier (re-build root + generate inclusion proof)
 *   - verify-audit-chain.ts CLI
 *
 * Spec (PLAN §5.2):
 *   leaf_hash_i  = SHA-256(0x00 || hex_to_bytes(row_hash))
 *   internal     = SHA-256(0x01 || left || right)
 *   odd count    = duplicate last leaf (RFC 6962 §2.1)
 *   empty tree   = SHA-256(0x00) — the "empty leaf" sentinel
 *
 * The domain separation bytes (0x00 leaf, 0x01 internal) are load-bearing;
 * a verifier that omits them produces a different root. The golden fixture
 * test/fixtures/merkle/rfc6962_test_vectors.json covers this.
 *
 * Row hashes are passed as 64-char lowercase hex strings (as stored in MySQL).
 */

import { createHash } from 'node:crypto';

export interface InclusionProof {
  /** 0-based index of the leaf in the sorted (by id ASC) leaf list. */
  leafIndex: number;
  /** Total number of leaves. */
  treeSize: number;
  /** Sibling hashes at each level, from leaf to root. Each is 32-byte Buffer. */
  path: Buffer[];
}

export interface InclusionProofHex {
  leafIndex: number;
  treeSize: number;
  /** Sibling hashes as 64-char lowercase hex. */
  path: string[];
}

/** EMPTY_ROOT = SHA-256(0x00) — used for empty-day attestations. */
export const EMPTY_ROOT: Buffer = sha256(Buffer.from([0x00]));

/**
 * Build the Merkle root from an ordered list of row_hash hex strings.
 * Returns 32-byte Buffer.
 */
export function buildMerkleRoot(rowHashes: string[]): Buffer {
  if (rowHashes.length === 0) return EMPTY_ROOT;
  const leaves = rowHashes.map(leafHash);
  return reduce(leaves);
}

/**
 * Build root AND return inclusion proof for the leaf at `leafIndex`.
 * leafIndex is 0-based, must be < rowHashes.length.
 */
export function buildWithProof(
  rowHashes: string[],
  leafIndex: number,
): { root: Buffer; proof: InclusionProof } {
  if (rowHashes.length === 0) throw new RangeError('buildWithProof: empty tree');
  if (leafIndex < 0 || leafIndex >= rowHashes.length) {
    throw new RangeError(`buildWithProof: leafIndex ${leafIndex} out of range 0..${rowHashes.length - 1}`);
  }
  const leaves = rowHashes.map(leafHash);
  const path: Buffer[] = [];
  const root = reduceWithProof(leaves, leafIndex, path);
  return {
    root,
    proof: { leafIndex, treeSize: rowHashes.length, path },
  };
}

/**
 * Verify an inclusion proof.
 * @param rowHash   The row_hash (64 hex) of the leaf to verify.
 * @param proof     The inclusion proof returned by buildWithProof or the API.
 * @param root      The expected Merkle root (32-byte Buffer or 64 hex).
 */
export function verifyInclusion(
  rowHash: string,
  proof: InclusionProof | InclusionProofHex,
  root: Buffer | string,
): boolean {
  const expectedRoot = typeof root === 'string' ? Buffer.from(root, 'hex') : root;
  let current = leafHash(rowHash);
  const { leafIndex, treeSize, path } = proof;

  // Re-walk the tree using the proof path.
  let idx = leafIndex;
  let sz = treeSize;

  for (const sibling of path) {
    const sibBuf = Buffer.isBuffer(sibling) ? sibling : Buffer.from(sibling as string, 'hex');
    if (idx % 2 === 0) {
      // current is left child
      current = internalHash(current, sibBuf);
    } else {
      // current is right child
      current = internalHash(sibBuf, current);
    }
    idx = Math.floor(idx / 2);
    sz = Math.ceil(sz / 2);
  }

  return current.equals(expectedRoot);
}

/** Convert InclusionProof (Buffer path) → InclusionProofHex for JSON serialization. */
export function proofToHex(proof: InclusionProof): InclusionProofHex {
  return {
    leafIndex: proof.leafIndex,
    treeSize: proof.treeSize,
    path: proof.path.map((b) => b.toString('hex')),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function leafHash(rowHashHex: string): Buffer {
  // leaf_hash = SHA-256(0x00 || hex_to_bytes(row_hash))
  const data = Buffer.concat([Buffer.from([0x00]), Buffer.from(rowHashHex, 'hex')]);
  return sha256(data);
}

function internalHash(left: Buffer, right: Buffer): Buffer {
  // internal = SHA-256(0x01 || left || right)
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Recursive Merkle reduce with RFC 6962 odd-count duplication.
 * Mutates the nodes array (flat bottom-up reduce).
 */
function reduce(nodes: Buffer[]): Buffer {
  const first = nodes[0];
  if (nodes.length === 1 && first !== undefined) return first;
  // Pad to even if odd (duplicate last)
  const last = nodes[nodes.length - 1];
  const level: Buffer[] = nodes.length % 2 === 0 ? [...nodes] : [...nodes, ...(last !== undefined ? [last] : [])];
  const next: Buffer[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const l = level[i];
    const r = level[i + 1];
    if (l !== undefined && r !== undefined) {
      next.push(internalHash(l, r));
    }
  }
  return reduce(next);
}

/**
 * Recursive reduce that also builds the proof path for leafIndex.
 * path is an output parameter (pushed in bottom-up order).
 */
function reduceWithProof(nodes: Buffer[], targetIdx: number, path: Buffer[]): Buffer {
  const first = nodes[0];
  if (nodes.length === 1 && first !== undefined) return first;
  const last = nodes[nodes.length - 1];
  const padded: Buffer[] = nodes.length % 2 === 0 ? [...nodes] : [...nodes, ...(last !== undefined ? [last] : [])];
  const next: Buffer[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const l = padded[i];
    const r = padded[i + 1];
    if (l !== undefined && r !== undefined) {
      next.push(internalHash(l, r));
    }
  }
  // The sibling of targetIdx at this level:
  const siblingIdx = targetIdx % 2 === 0 ? targetIdx + 1 : targetIdx - 1;
  const sibling = padded[siblingIdx];
  if (sibling !== undefined) {
    path.push(sibling);
  }
  return reduceWithProof(next, Math.floor(targetIdx / 2), path);
}

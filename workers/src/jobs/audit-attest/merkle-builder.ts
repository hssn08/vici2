/**
 * workers/src/jobs/audit-attest/merkle-builder.ts
 *
 * Thin wrapper around shared/lib/merkle.ts for the attestation worker.
 * Adds the EMPTY_ROOT hex export and the "build from DB rows" helper.
 */

import {
  buildMerkleRoot,
  EMPTY_ROOT,
} from '../../../../shared/lib/merkle.js';

export { EMPTY_ROOT };

export interface MerkleInput {
  id: bigint;
  row_hash: string;
}

/**
 * Build the Merkle root from a list of DB rows (sorted by id ASC).
 * Returns the root as a 64-char lowercase hex string.
 * Empty input returns the EMPTY_ROOT sentinel.
 */
export function buildRootFromRows(rows: MerkleInput[]): string {
  if (rows.length === 0) {
    return EMPTY_ROOT.toString('hex');
  }
  const hashes = rows.map((r) => r.row_hash);
  return buildMerkleRoot(hashes).toString('hex');
}

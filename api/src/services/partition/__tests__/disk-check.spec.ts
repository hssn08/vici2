/**
 * api/src/services/partition/__tests__/disk-check.spec.ts
 *
 * C04 — Tests for the disk-free pre-flight check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Mock statfs before importing disk-check
vi.mock('node:fs/promises', () => ({
  statfs: vi.fn(),
}));

import { statfs } from 'node:fs/promises';
import { checkDiskFree } from '../disk-check.js';

function makePrisma(partitionBytes: bigint, throwError?: Error): PrismaClient {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (throwError) throw throwError;
      if (sql.includes('@@datadir')) return [{ datadir: '/var/lib/mysql/' }];
      if (sql.includes('DATABASE()')) return [{ name: 'vici2' }];
      if (sql.includes('INFORMATION_SCHEMA.PARTITIONS')) {
        return [{ data_length: partitionBytes / 2n, index_length: partitionBytes / 2n }];
      }
      return [];
    }),
  } as unknown as PrismaClient;
}

describe('checkDiskFree', () => {
  const mockStatfs = vi.mocked(statfs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok=true when there is sufficient free space', async () => {
    const partitionBytes = BigInt(100 * 1024 * 1024); // 100 MB
    const db = makePrisma(partitionBytes);

    // 10 GB free
    mockStatfs.mockResolvedValueOnce({ bsize: 4096, bavail: 2_500_000 } as Awaited<ReturnType<typeof statfs>>);

    const result = await checkDiskFree(db, 'call_log', 'p_2022_01');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when free space < 20% of partition size', async () => {
    const partitionBytes = BigInt(100 * 1024 * 1024); // 100 MB
    const db = makePrisma(partitionBytes);

    // Only 5 MB free — less than 20% of 100 MB
    const freeBytes = 5 * 1024 * 1024;
    mockStatfs.mockResolvedValueOnce({ bsize: 4096, bavail: Math.floor(freeBytes / 4096) } as Awaited<ReturnType<typeof statfs>>);

    const result = await checkDiskFree(db, 'call_log', 'p_2022_01');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient_disk');
    }
  });

  it('returns ok=true for zero-byte partition (e.g. not found in INFORMATION_SCHEMA)', async () => {
    // Zero-byte partition → required = 0 → any free space passes
    const db = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes('INFORMATION_SCHEMA.PARTITIONS') && sql.includes('PARTITION_NAME')) {
          return []; // partition not found
        }
        if (sql.includes('@@datadir')) return [{ datadir: '/var/lib/mysql/' }];
        if (sql.includes('DATABASE()')) return [{ name: 'vici2' }];
        return [];
      }),
    } as unknown as PrismaClient;

    mockStatfs.mockResolvedValueOnce({ bsize: 4096, bavail: 1 } as Awaited<ReturnType<typeof statfs>>);

    const result = await checkDiskFree(db, 'call_log', 'p_2022_01');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with db_error when DB query fails', async () => {
    const db = makePrisma(0n, new Error('DB connection lost'));
    const result = await checkDiskFree(db, 'call_log', 'p_2022_01');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('db_error');
    }
  });

  it('returns ok=false with stat_error when statfs fails', async () => {
    const db = makePrisma(BigInt(10 * 1024 * 1024));
    mockStatfs.mockRejectedValueOnce(new Error('ENOENT: /var/lib/mysql not found'));

    const result = await checkDiskFree(db, 'call_log', 'p_2022_01');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('stat_error');
    }
  });
});

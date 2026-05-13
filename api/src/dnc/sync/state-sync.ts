// D05 — State DNC sync dispatcher (PLAN §4.1).
// Phase 1: scaffold only; per-state workers are stubs.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;

/** Template result returned by each state worker. */
export interface StateSyncResult {
  state: string;
  added: number;
  removed: number;
}

/**
 * Dispatcher: reads dnc_sync_config for enabled state sources,
 * runs the appropriate state worker, and records in dnc_sync_log.
 *
 * Phase 1: only returns stubs.  Per-state workers productionized in Phase 2.
 */
export async function runStateDncSync(
  redis: AnyRedis,
  prisma: AnyPrisma,
  targetState?: string, // run a single state if supplied
): Promise<StateSyncResult[]> {
  // Acquire top-level state-sync lock
  const lockKey = targetState
    ? `t:0:dnc:state:${targetState}:sync:lock`
    : "t:0:dnc:state:all:sync:lock";
  const lockId = `${process.pid}-${Date.now()}`;
   
  const acquired = await redis.set(lockKey, lockId, "NX", "EX", 3600);
  if (!acquired) return [];

  const results: StateSyncResult[] = [];

  try {
    // Query enabled state sources
     
    const rows: Array<{ source: string }> = await prisma.$queryRawUnsafe(
      `SELECT source FROM dnc_sync_config
       WHERE enabled = 1
         AND source LIKE 'state:%'
         ${targetState ? `AND source = 'state:${targetState}'` : ""}`,
    );

    for (const row of rows) {
      const st = row.source.replace("state:", "");
      // Phase 2 will have real implementations; Phase 1 = stub
      results.push({ state: st, added: 0, removed: 0 });

      // Update last_run_at
      await prisma.$executeRawUnsafe(
        `UPDATE dnc_sync_config SET last_run_at = NOW(), updated_at = NOW()
         WHERE source = ?`,
        row.source,
      );

      await prisma.$executeRawUnsafe(
        `INSERT INTO dnc_sync_log (source, kind, outcome, added_count, removed_count, started_at, completed_at)
         VALUES (?, 'delta', 'success', 0, 0, NOW() - INTERVAL 1 SECOND, NOW())`,
        row.source,
      );
    }

    return results;
  } finally {
    const val = await redis.get(lockKey);
    if (val === lockId) await redis.del(lockKey);
  }
}

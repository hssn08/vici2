/**
 * api/src/services/partition/registry.ts
 *
 * C04 — Partition rotation table registry.
 *
 * Defines the retention window and operational flags for every managed
 * partitioned table. The rotator reads this registry; tables not present
 * here are never touched by C04.
 *
 * Retention windows (from PLAN §2):
 *   call_log            4 years   (48 months)   F02
 *   recording_log       7 years   (84 months)   F02
 *   audit_log           7 years   (84 months)   F02 / C03   attestation-gated
 *   agent_log           13 months               F02
 *   drop_log            7 years   (84 months)   F02 / E05
 *   call_window_audit   4 years   (48 months)   F02 amendments / C01  attestation-gated
 *   dnc_sync_log        7 years   (84 months)   F02 amendments / D05  attestation-gated
 *   originate_audit     7 years   (84 months)   F02 amendments / T04  attestation-gated
 *   drop_gate_trans…    7 years   (84 months)   E05
 *   import_errors       90 days                 D02
 *   queue_calls         90 days                 I01
 *   queue_log           90 days                 I01
 *   consent_log         7 years   (84 months)   C02  attestation-gated
 */

export interface TableConfig {
  /** Exact MySQL table name. */
  table: string;
  /** Column used as the RANGE COLUMNS partition key. */
  partitionColumn: string;
  /**
   * Retention period in calendar months.
   * Use fractional months for sub-monthly windows (e.g. 3 for 90 days ≈ 3 months).
   * Rotator always computes the boundary as the first day of the month that is
   * retentionMonths before today.
   */
  retentionMonths: number;
  /**
   * When true, C04 must confirm an audit_attestation row exists for the
   * last day of the partition window before issuing DROP PARTITION.
   */
  requireAttestation: boolean;
}

/**
 * 90 days expressed as 3 months — the rotator computes boundaries at month
 * granularity, so 3 months ≈ 90 days is the correct approximation for
 * short-retention tables. This is intentionally conservative (3 months > 90 days).
 */
const NINETY_DAYS_AS_MONTHS = 3;

export const TABLE_REGISTRY: readonly TableConfig[] = [
  {
    table: 'call_log',
    partitionColumn: 'call_started',
    retentionMonths: 48, // 4 years
    requireAttestation: false,
  },
  {
    table: 'recording_log',
    partitionColumn: 'start_time',
    retentionMonths: 84, // 7 years
    requireAttestation: false,
  },
  {
    table: 'audit_log',
    partitionColumn: 'ts',
    retentionMonths: 84, // 7 years
    requireAttestation: true,
  },
  {
    table: 'agent_log',
    partitionColumn: 'event_at',
    retentionMonths: 13,
    requireAttestation: false,
  },
  {
    table: 'drop_log',
    partitionColumn: 'dropped_at',
    retentionMonths: 84, // 7 years
    requireAttestation: false,
  },
  {
    table: 'call_window_audit',
    partitionColumn: 'created_at',
    retentionMonths: 48, // 4 years
    requireAttestation: true,
  },
  {
    table: 'dnc_sync_log',
    partitionColumn: 'started_at',
    retentionMonths: 84, // 7 years
    requireAttestation: true,
  },
  {
    table: 'originate_audit',
    partitionColumn: 'originated_at',
    retentionMonths: 84, // 7 years
    requireAttestation: true,
  },
  // Tables below are defined by modules not yet shipped (E05, D02, I01, C02).
  // C04 handles them automatically once their partitions appear in
  // INFORMATION_SCHEMA.PARTITIONS. If the table does not yet exist,
  // the rotator skips it silently.
  {
    table: 'drop_gate_transition_log',
    partitionColumn: 'created_at',
    retentionMonths: 84, // 7 years — E05
    requireAttestation: false,
  },
  {
    table: 'import_errors',
    partitionColumn: 'created_at',
    retentionMonths: NINETY_DAYS_AS_MONTHS, // 90 days — D02
    requireAttestation: false,
  },
  {
    table: 'queue_calls',
    partitionColumn: 'enqueued_at',
    retentionMonths: NINETY_DAYS_AS_MONTHS, // 90 days — I01
    requireAttestation: false,
  },
  {
    table: 'queue_log',
    partitionColumn: 'created_at',
    retentionMonths: NINETY_DAYS_AS_MONTHS, // 90 days — I01
    requireAttestation: false,
  },
  {
    table: 'consent_log',
    partitionColumn: 'created_at',
    retentionMonths: 84, // 7 years — C02
    requireAttestation: true,
  },
] as const;

/** Indexed lookup by table name for O(1) access. */
export const TABLE_MAP = new Map<string, TableConfig>(
  TABLE_REGISTRY.map((c) => [c.table, c]),
);

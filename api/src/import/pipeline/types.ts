// D02 — Import job payload + pipeline row types (PLAN §6, §7)

import type { ErrorCode } from "./error-codes.js";

// ── Job payload (queued by API → processed by worker) ──────────────────────

export interface ImportJobPayload {
  importId: string;
  tenantId: number;
  listId: number;
  ownerUserId: number;
}

// ── Column-mapping types (PLAN §7.1) ──────────────────────────────────────

export type TransformName =
  | "phone"
  | "lower"
  | "upper"
  | "trim"
  | "nullify_blank"
  | "parseInt"
  | "parseFloat"
  | `date:${string}`
  | `map:${string}`
  | `concat:${string}`;

export interface MappingRow {
  source: string;
  target: string;
  transform?: string;  // comma-separated transform names
}

export interface ColumnMapping {
  version: 1;
  rows: MappingRow[];
  options?: {
    default_status?: string;
    default_country?: string;
    lookup_state_from_zip?: boolean;
    skip_blank_rows?: boolean;
  };
}

// ── Pipeline row types ────────────────────────────────────────────────────

/** Row as it flows from csv-parse (Stage 2). */
export interface RawCsvRow {
  record: string[];
  info: { lines: number; records: number };
}

/** Row after mapping applied (Stage 3). */
export interface MappedRow {
  mapped: Record<string, string>;
  rawRecord: string[];
  info: { lines: number; records: number };
}

/** Row after normalize+validate (Stage 4); may carry errors. */
export interface NormalizedRow {
  lead: NormalizedLead | null;  // null if row has fatal error
  rawRecord: string[];
  info: { lines: number; records: number };
  errors: RowError[];
}

/** Validated lead ready for DNC/TZ scrub (Stage 5 output). */
export interface ValidRow {
  lead: NormalizedLead;
  rawRecord: string[];
  info: { lines: number; records: number };
}

/** Lead data after normalization. */
export interface NormalizedLead {
  phoneE164: string;
  phoneAlt?: string;
  phoneAlt2?: string;
  firstName?: string;
  lastName?: string;
  middleInitial?: string;
  title?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode: string;
  email?: string;
  dateOfBirth?: string;  // ISO date string YYYY-MM-DD
  gender?: "M" | "F" | "U";
  comments?: string;
  rank?: number;
  ownerUserId?: bigint;
  vendorLeadCode?: string;
  sourceId?: string;
  status: string;
  tzBlocked: boolean;
  dncBlocked: boolean;
  dncPolicy?: "skip" | "mark" | "proceed";
  customData: Record<string, unknown>;
}

/** Error attached to a row. */
export interface RowError {
  code: ErrorCode;
  message: string;
  sourceLine: number;
  sourceRecord: number;
  rawRecord: string[];
}

// ── Progress shape (BullMQ job.updateProgress) ────────────────────────────

export interface ImportProgress {
  processed: number;
  total: number | null;
  inserted: number;
  skipped: number;
  errored: number;
  batchIndex: number;
}

// ── Import meta options (from POST /imports body) ─────────────────────────

export interface ImportMeta {
  name?: string;
  delimiter?: "auto" | "," | ";" | "\t";
  encoding?: "auto" | "utf-8" | "windows-1252";
  header_row?: boolean;
  skip_rows?: number;
  mapping?: ColumnMapping | "inherit" | "vicidial_default";
  dedup_policy?: "skip_in_file" | "skip_cross_list" | "skip_tenant";
  dnc_policy?: "skip" | "mark" | "proceed";
  tz_policy?: "skip" | "mark" | "proceed";
  default_country?: string;
  default_status?: string;
  options?: {
    lookup_state_from_zip?: boolean;
    legacy_backslash_escape?: boolean;
    strict_phone?: boolean;
    persist_raw_errors?: boolean;
    raw_insert?: boolean;
  };
}

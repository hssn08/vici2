// D02 — Shared types for import handlers (local copy to avoid cross-package imports)

export interface MappingRow {
  source: string;
  target: string;
  transform?: string;
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

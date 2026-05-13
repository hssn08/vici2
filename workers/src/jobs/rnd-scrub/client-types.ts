/**
 * workers/src/jobs/rnd-scrub/client-types.ts
 *
 * N06 — RND API response types shared between processor, result-writer, and tests.
 * Mirrors api/src/integrations/rnd/client.ts interfaces (kept in sync manually).
 */

export interface RndQueryItem {
  tn: string;    // E.164
  date: string;  // YYYY-MM-DD
}

export interface RndResultItem {
  tn: string;
  result: 'yes' | 'no' | 'no_data';
  disconnect_date: string | null;
  queried_at: string;
}

export interface RndBatchResponse {
  results: RndResultItem[];
  query_count: number;
  subscription_remaining: number;
}

/**
 * Minimal RndClient interface used by the worker processor.
 * The real implementation lives in api/src/integrations/rnd/client.ts,
 * but the worker inlines its own HTTP calls to stay self-contained.
 */
export interface RndClientLike {
  query(items: RndQueryItem[]): Promise<RndBatchResponse>;
}

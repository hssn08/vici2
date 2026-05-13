/**
 * web/src/components/recordings/types.ts
 *
 * Shared TypeScript types for R03 recording playback UI.
 */

export interface RecordingListItem {
  id: string;
  call_uuid: string;
  start_time: string;
  duration_sec: number | null;
  campaign_id: string | null;
  campaign_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  lead_phone: string | null;
  lifecycle_state: string;
  consent_status: string;
  has_transcript: boolean;
  has_legal_hold: boolean;
  size_bytes: string | null;
}

export interface RecordingListResponse {
  recordings: RecordingListItem[];
  next_cursor: string | null;
  total_hint: number | null;
}

export interface RecordingDetail {
  id: string;
  call_uuid: string;
  start_time: string;
  duration_sec: number | null;
  size_bytes: string | null;
  sha256: string | null;
  lifecycle_state: string;
  consent_status: string;
  failure_reason: string | null;
  encoded_at: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  lead_id: string | null;
  lead_phone: string | null;
  disposition: string | null;
  transcript_status: string;
  transcript_word_count: number | null;
  has_legal_hold: boolean;
  legal_hold_reason: string | null;
  storage_url_prefix: string | null;
  can_listen: boolean;
  can_download: boolean;
  can_legal_hold: boolean;
  can_integrity_verify: boolean;
}

export interface RecordingFilters {
  date_from?: string;
  date_to?: string;
  campaign_id?: string;
  agent_id?: string;
  lead_phone_last4?: string;
  call_uuid?: string;
  has_transcript?: 'true' | 'false' | '';
  has_legal_hold?: 'true' | 'false' | '';
  lifecycle_state?: string;
  consent_status?: string;
}

/** Format seconds as mm:ss or h:mm:ss */
export function formatDuration(sec: number | null): string {
  if (sec === null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Format bytes as human-readable string */
export function formatBytes(bytes: string | null): string {
  if (!bytes) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lifecycle state → display label + badge tone */
export function lifecycleStateBadge(state: string): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'brand' } {
  switch (state) {
    case 'available':  return { label: 'Available',  tone: 'success' };
    case 'uploaded':   return { label: 'Uploaded',   tone: 'brand' };
    case 'archived':   return { label: 'Archived',   tone: 'neutral' };
    case 'deleted':    return { label: 'Deleted',    tone: 'danger' };
    case 'failed':     return { label: 'Failed',     tone: 'danger' };
    case 'uploading':  return { label: 'Uploading',  tone: 'warning' };
    case 'pending':    return { label: 'Pending',    tone: 'warning' };
    default:           return { label: state,        tone: 'neutral' };
  }
}

/** Consent status → display label */
export function consentLabel(status: string): string {
  switch (status) {
    case 'prompted_accepted': return 'Accepted';
    case 'prompted_declined': return 'Declined';
    case 'not_required':      return 'Not required';
    case 'assumed':           return 'Assumed';
    case 'beep_only':         return 'Beep notified';
    case 'prompted_assumed':  return 'Prompted / assumed';
    default:                  return status;
  }
}

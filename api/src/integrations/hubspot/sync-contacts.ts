// N04 — HubSpot contact sync logic (pure; no BullMQ imports)
// Fetches contacts from HubSpot and upserts them into the vici2 leads table.

import type { IHubspotClient } from './hubspot-client.js';

export interface HubspotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    phone?: string;
    mobilephone?: string;
    email?: string;
    hs_lead_status?: string;
    lifecyclestage?: string;
    lastmodifieddate?: string;
  };
}

interface ContactSearchResponse {
  results: HubspotContact[];
  paging?: { next?: { after?: string } };
  total: number;
}

interface UpsertResult {
  upserted: number;
  skipped: number;
  failed: number;
  errors: Array<{ hsObjectId: string; error: string }>;
  lastModifiedDate: string | null;
}

/**
 * Normalize a phone string to E.164 using a simple best-effort approach.
 * Production uses libphonenumber-js; here we do basic normalization.
 */
export function normalizePhone(raw: string, defaultRegion = 'US'): { e164: string | null; warning: string | null } {
  if (!raw) return { e164: null, warning: 'empty phone' };
  // Strip all non-digit characters except leading +
  const stripped = raw.replace(/[^\d+]/g, '');
  if (!stripped) return { e164: null, warning: `unparseable: ${raw}` };
  if (stripped.startsWith('+') && stripped.length >= 11) return { e164: stripped, warning: null };
  // US national number — 10 digits
  if (stripped.length === 10 && defaultRegion === 'US') return { e164: `+1${stripped}`, warning: null };
  if (stripped.length === 11 && stripped.startsWith('1') && defaultRegion === 'US') return { e164: `+${stripped}`, warning: null };
  return { e164: stripped.startsWith('+') ? stripped : `+${stripped}`, warning: `assumed + prefix: ${raw}` };
}

export interface SyncContactsOptions {
  client: IHubspotClient;
  tenantId: bigint;
  syncMode: 'FULL' | 'INCREMENTAL';
  lastSyncCursor: Date | null;
  pagingCursor?: string;
  syncOverwritesManual: boolean;
  /** Receives pages of contacts for DB upsert */
  onPage: (contacts: HubspotContact[]) => Promise<void>;
  /** Progress update callback */
  onProgress?: (counts: { fetched: number; cursor: string | null }) => Promise<void>;
}

/**
 * Stream HubSpot contacts, calling onPage for each batch.
 * Returns summary counts and the max lastmodifieddate seen.
 */
export async function syncContacts(opts: SyncContactsOptions): Promise<{
  contactsFetched: number;
  lastModifiedDate: string | null;
  finalPagingCursor: string | null;
}> {
  const {
    client,
    syncMode,
    lastSyncCursor,
    pagingCursor: initialPagingCursor,
    onPage,
    onProgress,
  } = opts;

  const properties = [
    'firstname', 'lastname', 'phone', 'mobilephone', 'email',
    'hs_lead_status', 'lifecyclestage', 'lastmodifieddate', 'createdate',
  ];

  let totalFetched = 0;
  let afterCursor: string | undefined = initialPagingCursor;
  let lastModifiedDate: string | null = null;

  // Build filter for incremental sync
  const filterGroups = syncMode === 'INCREMENTAL' && lastSyncCursor
    ? [{
        filters: [{
          propertyName: 'lastmodifieddate',
          operator: 'GTE',
          value: String(lastSyncCursor.getTime()),
        }],
      }]
    : [];

  while (true) {
    const body: Record<string, unknown> = {
      properties,
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      limit: 100,
      ...(filterGroups.length > 0 ? { filterGroups } : {}),
      ...(afterCursor ? { after: afterCursor } : {}),
    };

    const before = Date.now();
    const res = await client.post<ContactSearchResponse>('/crm/v3/objects/contacts/search', body);
    const elapsed = Date.now() - before;

    const page = res.data;
    const contacts = page.results ?? [];

    if (contacts.length > 0) {
      await onPage(contacts);
      totalFetched += contacts.length;

      // Track max lastmodifieddate seen
      for (const c of contacts) {
        const mod = c.properties.lastmodifieddate;
        if (mod && (!lastModifiedDate || mod > lastModifiedDate)) {
          lastModifiedDate = mod;
        }
      }
    }

    afterCursor = page.paging?.next?.after;

    if (onProgress) {
      await onProgress({ fetched: totalFetched, cursor: afterCursor ?? null });
    }

    if (!afterCursor || contacts.length < 100) break;

    // Throttle: stay under 10 req/10s burst limit
    const throttle = Math.max(0, 100 - elapsed);
    if (throttle > 0) await new Promise((r) => setTimeout(r, throttle));
  }

  return { contactsFetched: totalFetched, lastModifiedDate, finalPagingCursor: afterCursor ?? null };
}

/**
 * Fetch a single HubSpot contact by object ID.
 */
export async function fetchContact(
  client: IHubspotClient,
  hsObjectId: string,
): Promise<HubspotContact | null> {
  try {
    const properties = 'firstname,lastname,phone,mobilephone,email,hs_lead_status,lifecyclestage,lastmodifieddate';
    const res = await client.get<HubspotContact>(
      `/crm/v3/objects/contacts/${hsObjectId}?properties=${properties}`,
    );
    return res.data;
  } catch {
    return null;
  }
}

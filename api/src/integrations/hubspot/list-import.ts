// N04 — HubSpot list fetch and member import helpers

import type { IHubspotClient } from './hubspot-client.js';

export interface HubspotList {
  listId: string;
  name: string;
  size: number;
  processingType: string;  // MANUAL, SNAPSHOT, DYNAMIC
}

interface ListsResponse {
  lists: Array<{
    listId: string;
    name: string;
    size: number;
    processingType: string;
  }>;
  hasMore: boolean;
  offset: number;
}

interface MembershipResponse {
  results: Array<{ id: string }>;
  paging?: { next?: { after?: string } };
}

/**
 * Fetch available HubSpot contact lists for the connected portal.
 * Returns up to 200 lists (sufficient for most portals).
 */
export async function fetchHubspotLists(client: IHubspotClient): Promise<HubspotList[]> {
  const res = await client.get<ListsResponse>(
    '/crm/v3/lists?objectTypeId=0-1&processingTypes=MANUAL,SNAPSHOT,DYNAMIC&limit=200',
  );
  const data = res.data;
  if (!data || !Array.isArray(data.lists)) return [];
  return data.lists.map((l) => ({
    listId: l.listId,
    name: l.name,
    size: l.size,
    processingType: l.processingType,
  }));
}

/**
 * Fetch contact IDs (hs_object_id) that are members of a HubSpot list.
 * Paginates until all members are fetched.
 */
export async function* fetchListMemberIds(
  client: IHubspotClient,
  listId: string,
): AsyncGenerator<string[]> {
  let afterCursor: string | undefined;

  while (true) {
    const path = `/crm/v3/lists/${listId}/memberships${afterCursor ? `?after=${afterCursor}` : ''}`;
    const res = await client.get<MembershipResponse>(path);
    const page = res.data;
    const ids = (page.results ?? []).map((r) => r.id);
    if (ids.length > 0) yield ids;

    afterCursor = page.paging?.next?.after;
    if (!afterCursor || ids.length === 0) break;
  }
}

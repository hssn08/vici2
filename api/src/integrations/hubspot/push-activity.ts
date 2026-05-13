// N04 — HubSpot engagement write-back
// Creates or updates a CALL engagement in HubSpot after a call is dispositioned.

import type { IHubspotClient } from './hubspot-client.js';
import { resolveCallStatus } from './property-map.js';

export interface PushActivityOptions {
  client: IHubspotClient;
  hsObjectId: string;            // HubSpot contact ID
  disposition: string;           // vici2 dispo code
  dispositionMap: Record<string, string>;
  durationMs: number;
  fromNumber: string;            // E.164
  toNumber: string;              // E.164
  startedAt: string;             // ISO 8601
  callId: string;                // vici2 call UUID (used in body text)
  recordingUrl?: string;
  preCreatedEngagementId?: string;
}

interface CallEngagementProperties {
  hs_call_title: string;
  hs_call_direction: string;
  hs_call_status: string;
  hs_call_duration: number;
  hs_call_from_number: string;
  hs_call_to_number: string;
  hs_call_body: string;
  hs_timestamp: string;
  hs_call_recording_url?: string;
}

interface EngagementCreateResponse {
  id: string;
}

/**
 * Push a call engagement to HubSpot.
 * If preCreatedEngagementId is provided, PATCHes the pre-created engagement.
 * Otherwise, POSTs a new one with contact association.
 */
export async function pushCallActivity(opts: PushActivityOptions): Promise<string> {
  const {
    client,
    hsObjectId,
    disposition,
    dispositionMap,
    durationMs,
    fromNumber,
    toNumber,
    startedAt,
    callId,
    recordingUrl,
    preCreatedEngagementId,
  } = opts;

  const callStatus = resolveCallStatus(disposition, dispositionMap);

  const properties: CallEngagementProperties = {
    hs_call_title: 'Outbound call from vici2',
    hs_call_direction: 'OUTBOUND',
    hs_call_status: callStatus,
    hs_call_duration: durationMs,
    hs_call_from_number: fromNumber,
    hs_call_to_number: toNumber,
    hs_call_body: `Disposition: ${disposition}. vici2 call ID: ${callId}`,
    hs_timestamp: startedAt,
    ...(recordingUrl ? { hs_call_recording_url: recordingUrl } : {}),
  };

  if (preCreatedEngagementId) {
    // Update pre-created engagement (no need to re-associate)
    await client.patch(`/crm/v3/objects/calls/${preCreatedEngagementId}`, { properties });
    return preCreatedEngagementId;
  }

  // Create new engagement with contact association
  const payload = {
    properties,
    associations: [
      {
        to: { id: hsObjectId },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }, // call → contact
        ],
      },
    ],
  };

  const res = await client.post<EngagementCreateResponse>('/crm/v3/objects/calls', payload);
  return res.data.id;
}

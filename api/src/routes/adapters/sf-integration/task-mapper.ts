// N03 — Maps vici2 dispo commit data to Salesforce Task fields.

import { DEFAULT_STATUS_MAP, type SfFieldMappings } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispoCommitPayload {
  callId: string;
  dispo: string;
  dispoLabel: string;
  notes: string;
  sfRecordId?: string;
  sfObjectType?: 'Lead' | 'Contact';
  callDurationSeconds: number;
  callStartAt: string; // ISO 8601
  direction: 'inbound' | 'outbound';
}

export interface SfTaskPayload {
  Subject: string;
  Status: string;
  ActivityDate: string;           // YYYY-MM-DD
  CallDurationInSeconds: number;
  CallType: 'Inbound' | 'Outbound';
  Description: string;
  WhoId?: string;                 // SF Contact or Lead ID
  WhatId?: string;                // Phase 2: Account / Opportunity
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export function mapDispoToSfTask(
  payload: DispoCommitPayload,
  fieldMappings: SfFieldMappings,
): SfTaskPayload {
  const statusMap: Record<string, string> = {
    ...DEFAULT_STATUS_MAP,
    ...(fieldMappings.dispoToTaskStatus ?? {}),
  };
  const taskStatus = statusMap[payload.dispo] ?? 'Completed';

  const callDate =
    (payload.callStartAt && payload.callStartAt.length >= 10)
      ? payload.callStartAt.substring(0, 10)
      : new Date().toISOString().substring(0, 10);

  const callTypeOverride = fieldMappings.dispoToCallType?.[payload.dispo];
  const callType: 'Inbound' | 'Outbound' =
    callTypeOverride ?? (payload.direction === 'inbound' ? 'Inbound' : 'Outbound');

  const task: SfTaskPayload = {
    Subject: `Call: ${payload.dispoLabel || payload.dispo}`,
    Status: taskStatus,
    ActivityDate: callDate,
    CallDurationInSeconds: payload.callDurationSeconds,
    CallType: callType,
    Description:
      `[vici2:callId:${payload.callId}]\n` +
      (payload.notes ? `Notes: ${payload.notes}\n` : ''),
  };

  if (payload.sfRecordId) {
    // Both Lead and Contact WhoId
    task.WhoId = payload.sfRecordId;
  }

  return task;
}

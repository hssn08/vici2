// N02 — Per-category frozen variable vocabulary.
// FROZEN: any addition to a category's vocabulary requires an RFC against N02.

export interface BaseEmailContext {
  user: {
    name: string;   // user.fullName ?? user.username
    email: string;  // user.email
    role: string;   // user.role
  };
  tenant: {
    name: string;   // tenant.name
  };
  unsubscribeUrl: string; // generated HMAC token URL
}

export interface CallbackDueContext extends BaseEmailContext {
  callback: {
    leadName: string;
    leadPhone: string;        // E.164 (use {{phoneFormat callback.leadPhone}})
    scheduledAtLocal: string; // ISO 8601 (use {{formatDate ...}})
    link: string;             // absolute URL to /callbacks?id=<id>
    notes: string;
  };
}

export interface CallbackUpcomingContext extends BaseEmailContext {
  callback: {
    leadName: string;
    leadPhone: string;
    scheduledAtLocal: string;
    minutesUntilDue: number;
    link: string;
  };
}

export interface ImportCompleteContext extends BaseEmailContext {
  import: {
    fileName: string;
    listName: string;
    rowsImported: number;
    rowsSkipped: number;
    rowsFailed: number;
    completedAt: string; // ISO 8601
    link: string;        // absolute URL to /admin/lists/<id>
  };
}

export interface ImportFailedContext extends BaseEmailContext {
  import: {
    fileName: string;
    listName: string;
    errorSummary: string; // first 500 chars of error message
    failedAt: string;
    link: string;
  };
}

export interface RecordingFailedContext extends BaseEmailContext {
  recording: {
    callUuid: string;
    failedAt: string;
    reason: string;
  };
}

export interface AgentDisconnectedContext extends BaseEmailContext {
  agent: {
    name: string;
    disconnectedAt: string;
    callUuid: string | null;
  };
}

export interface DropGateEngagedContext extends BaseEmailContext {
  dropGate: {
    campaignName: string;
    engagedAt: string;
    dropRate: number;  // percentage e.g. 4.2
    threshold: number; // configured threshold e.g. 3.0
  };
}

export type EmailContext =
  | CallbackDueContext
  | CallbackUpcomingContext
  | ImportCompleteContext
  | ImportFailedContext
  | RecordingFailedContext
  | AgentDisconnectedContext
  | DropGateEngagedContext;

// ---------------------------------------------------------------------------
// Category variable vocabulary for the UI sidebar
// ---------------------------------------------------------------------------

export interface VarDef {
  path: string;
  description: string;
  example: string;
}

export const CATEGORY_VARS: Record<string, VarDef[]> = {
  callback_due: [
    { path: 'user.name', description: 'Agent full name', example: 'Jane Smith' },
    { path: 'user.email', description: 'Agent email', example: 'jane@acme.com' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'callback.leadName', description: 'Lead full name', example: 'John Doe' },
    { path: 'callback.leadPhone', description: 'Lead phone (E.164)', example: '+15551234567' },
    { path: 'callback.scheduledAtLocal', description: 'Scheduled time (ISO 8601)', example: '2026-05-13T14:30:00-05:00' },
    { path: 'callback.link', description: 'Link to callback', example: 'https://app.example.com/callbacks?id=123' },
    { path: 'callback.notes', description: 'Callback notes', example: 'Ask about premium plan' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
  callback_upcoming: [
    { path: 'user.name', description: 'Agent full name', example: 'Jane Smith' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'callback.leadName', description: 'Lead full name', example: 'John Doe' },
    { path: 'callback.leadPhone', description: 'Lead phone (E.164)', example: '+15551234567' },
    { path: 'callback.minutesUntilDue', description: 'Minutes until callback is due', example: '15' },
    { path: 'callback.scheduledAtLocal', description: 'Scheduled time (ISO 8601)', example: '2026-05-13T14:30:00-05:00' },
    { path: 'callback.link', description: 'Link to callback', example: 'https://app.example.com/callbacks?id=123' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
  import_complete: [
    { path: 'user.name', description: 'User who triggered import', example: 'Jane Smith' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'import.fileName', description: 'Uploaded file name', example: 'leads_may_2026.csv' },
    { path: 'import.listName', description: 'Target list name', example: 'May 2026 Campaign' },
    { path: 'import.rowsImported', description: 'Number of rows imported', example: '1500' },
    { path: 'import.rowsSkipped', description: 'Number of rows skipped (duplicates)', example: '23' },
    { path: 'import.rowsFailed', description: 'Number of rows failed (bad data)', example: '2' },
    { path: 'import.completedAt', description: 'Import completion time (ISO 8601)', example: '2026-05-13T10:00:00Z' },
    { path: 'import.link', description: 'Link to the list', example: 'https://app.example.com/admin/lists/456' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
  import_failed: [
    { path: 'user.name', description: 'User who triggered import', example: 'Jane Smith' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'import.fileName', description: 'Uploaded file name', example: 'leads_may_2026.csv' },
    { path: 'import.listName', description: 'Target list name', example: 'May 2026 Campaign' },
    { path: 'import.errorSummary', description: 'Error summary (first 500 chars)', example: 'Invalid phone format in column 3' },
    { path: 'import.failedAt', description: 'Failure time (ISO 8601)', example: '2026-05-13T10:00:00Z' },
    { path: 'import.link', description: 'Link to the list', example: 'https://app.example.com/admin/lists/456' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
  recording_failed: [
    { path: 'user.name', description: 'Agent / admin name', example: 'Jane Smith' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'recording.callUuid', description: 'Call UUID', example: 'abc123-...' },
    { path: 'recording.failedAt', description: 'Failure time (ISO 8601)', example: '2026-05-13T10:00:00Z' },
    { path: 'recording.reason', description: 'Failure reason', example: 'Disk quota exceeded' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
  agent_disconnected: [
    { path: 'user.name', description: 'Supervisor / admin name', example: 'Jane Smith' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'agent.name', description: 'Disconnected agent name', example: 'Bob Jones' },
    { path: 'agent.disconnectedAt', description: 'Disconnect time (ISO 8601)', example: '2026-05-13T10:00:00Z' },
    { path: 'agent.callUuid', description: 'Call UUID (if on a call)', example: 'abc123-...' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
  drop_gate_engaged: [
    { path: 'user.name', description: 'Admin name', example: 'Jane Smith' },
    { path: 'tenant.name', description: 'Tenant / company name', example: 'Acme Corp' },
    { path: 'dropGate.campaignName', description: 'Campaign name', example: 'May Outbound' },
    { path: 'dropGate.engagedAt', description: 'Gate engaged time (ISO 8601)', example: '2026-05-13T10:00:00Z' },
    { path: 'dropGate.dropRate', description: 'Current drop rate percentage', example: '4.2' },
    { path: 'dropGate.threshold', description: 'Configured threshold percentage', example: '3.0' },
    { path: 'unsubscribeUrl', description: 'One-click unsubscribe URL', example: 'https://app.example.com/api/notifications/unsubscribe?token=...' },
  ],
};

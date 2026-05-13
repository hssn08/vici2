// N03 — postMessage bridge between vici2 inner iframe and SF adapter iframe.
//
// This module validates origin on all incoming messages and provides typed
// helpers for posting outbound messages to window.parent (the adapter).

// ---------------------------------------------------------------------------
// Message types (discriminated union)
// ---------------------------------------------------------------------------

// SF → vici2 (inbound from adapter)
export interface SfDialMessage {
  type: 'sf:dial';
  number: string;
  recordId: string;
  recordName: string;
  objectType: 'Lead' | 'Contact' | 'Account' | string;
}

export interface SfInitMessage {
  type: 'sf:init';
  userId: string;
  orgId: string;
  apiVersion: string;
  tenantSlug: string;
}

export interface SfNavigateMessage {
  type: 'sf:navigate';
  recordId: string;
  objectType: string;
}

export interface SfPanelOpenMessage { type: 'sf:panelOpen'; }
export interface SfPanelCloseMessage { type: 'sf:panelClose'; }

export type InboundSfMessage =
  | SfDialMessage
  | SfInitMessage
  | SfNavigateMessage
  | SfPanelOpenMessage
  | SfPanelCloseMessage;

// vici2 → SF (outbound to adapter)
export interface Vici2CallConnectedMessage {
  type: 'vici2:callConnected';
  callId: string;
  leadPhone: string;
  leadName: string;
  sfRecordId?: string;
  direction: 'inbound' | 'outbound';
}

export interface Vici2CallEndedMessage {
  type: 'vici2:callEnded';
  callId: string;
  durationSeconds: number;
}

export interface Vici2DispoCommittedMessage {
  type: 'vici2:dispoCommitted';
  callId: string;
  dispo: string;
  dispoLabel: string;
  notes: string;
  leadId: number;
  sfRecordId?: string;
  sfObjectType?: 'Lead' | 'Contact';
  callDurationSeconds: number;
  callStartAt: string;
  direction: 'inbound' | 'outbound';
}

export interface Vici2AgentStateMessage {
  type: 'vici2:agentState';
  state: string;
  pauseCode?: string;
}

export interface Vici2ScreenPopMessage {
  type: 'vici2:screenPop';
  sfRecordId: string;
  objectType: 'Lead' | 'Contact' | 'Account';
}

export type OutboundVici2Message =
  | Vici2CallConnectedMessage
  | Vici2CallEndedMessage
  | Vici2DispoCommittedMessage
  | Vici2AgentStateMessage
  | Vici2ScreenPopMessage;

// ---------------------------------------------------------------------------
// Origin resolution
// ---------------------------------------------------------------------------

export function getAdapterOrigin(): string {
  return process.env.NEXT_PUBLIC_API_ORIGIN ?? 'https://api.vici2.example.com';
}

// ---------------------------------------------------------------------------
// Inbound message handler registration
// ---------------------------------------------------------------------------

export type SfMessageHandler = (msg: InboundSfMessage) => void;

export function registerSfMessageHandler(
  handler: SfMessageHandler,
  adapterOrigin?: string,
): () => void {
  const origin = adapterOrigin ?? getAdapterOrigin();

  function onMessage(e: MessageEvent): void {
    if (e.origin !== origin) return;
    const msg = e.data as InboundSfMessage;
    if (!msg || typeof msg.type !== 'string') return;
    // Validate that it's a known SF message type
    const known = ['sf:dial', 'sf:init', 'sf:navigate', 'sf:panelOpen', 'sf:panelClose'];
    if (!known.includes(msg.type)) return;
    handler(msg);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', onMessage, false);
  }

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', onMessage, false);
    }
  };
}

// ---------------------------------------------------------------------------
// Outbound: post to adapter (window.parent)
// ---------------------------------------------------------------------------

export function postToAdapter(msg: OutboundVici2Message, adapterOrigin?: string): void {
  if (typeof window === 'undefined') return;
  const origin = adapterOrigin ?? getAdapterOrigin();
  // In non-embedded context window.parent === window; guard with origin check
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(msg, origin);
  }
}

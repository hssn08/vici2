'use client';

// N03 — useSfBridge React hook.
// Wires SF adapter postMessage events to vici2 stores and posts
// call state changes back to the adapter.

import { useEffect, useRef } from 'react';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import {
  registerSfMessageHandler,
  postToAdapter,
  getAdapterOrigin,
  type SfDialMessage,
} from './openCtiBridge.js';

// ---------------------------------------------------------------------------
// Minimal store interfaces (type-only; real stores supply these via zustand)
// ---------------------------------------------------------------------------

export interface ActiveCall {
  callId: string;
  leadPhone: string;
  leadName: string;
  sfRecordId?: string;
  direction: 'inbound' | 'outbound';
  status: 'ringing' | 'connected' | 'ended';
  duration: number;
}

export interface SfBridgeOptions {
  /** Called when the adapter fires sf:dial — hook caller handles lead dedup + dial */
  onDial?: (msg: SfDialMessage) => void;
  /** Current active call — watch for status changes to post to adapter */
  activeCall?: ActiveCall | null;
  /** Current agent state string e.g. 'READY', 'PAUSED', 'INCALL' */
  agentState?: string;
}

function normalizePhone(raw: string): string | null {
  try {
    const parsed = parsePhoneNumberFromString(raw, 'US');
    if (parsed?.isValid()) return parsed.number;
  } catch { /* noop */ }
  return null;
}

export function useSfBridge(opts: SfBridgeOptions = {}): void {
  const { onDial, activeCall, agentState } = opts;
  const adapterOrigin = getAdapterOrigin();

  // Track previous call status to avoid re-posting on unrelated re-renders
  const prevCallStatusRef = useRef<string | undefined>(undefined);
  const prevAgentStateRef = useRef<string | undefined>(undefined);

  // 1. Listen for SF → vici2 messages
  useEffect(() => {
    const cleanup = registerSfMessageHandler(
      (msg) => {
        switch (msg.type) {
          case 'sf:init':
            if (typeof sessionStorage !== 'undefined') {
              sessionStorage.setItem('sf:orgId', msg.orgId);
              sessionStorage.setItem('sf:userId', msg.userId);
              sessionStorage.setItem('sf:tenantSlug', msg.tenantSlug);
            }
            break;
          case 'sf:dial': {
            const e164 = normalizePhone(msg.number);
            if (!e164) return;
            onDial?.({ ...msg, number: e164 });
            break;
          }
          case 'sf:navigate':
          case 'sf:panelOpen':
          case 'sf:panelClose':
            // Phase 1: no-op
            break;
        }
      },
      adapterOrigin,
    );
    return cleanup;
  }, [adapterOrigin, onDial]);

  // 2. Post call state changes to adapter
  useEffect(() => {
    if (!activeCall) return;
    if (prevCallStatusRef.current === activeCall.status) return;
    prevCallStatusRef.current = activeCall.status;

    if (activeCall.status === 'connected') {
      postToAdapter({
        type: 'vici2:callConnected',
        callId: activeCall.callId,
        leadPhone: activeCall.leadPhone,
        leadName: activeCall.leadName,
        sfRecordId: activeCall.sfRecordId,
        direction: activeCall.direction,
      }, adapterOrigin);
    } else if (activeCall.status === 'ended') {
      postToAdapter({
        type: 'vici2:callEnded',
        callId: activeCall.callId,
        durationSeconds: activeCall.duration,
      }, adapterOrigin);
    }
  }, [activeCall, adapterOrigin]);

  // 3. Post agent state changes to adapter
  useEffect(() => {
    if (!agentState || prevAgentStateRef.current === agentState) return;
    prevAgentStateRef.current = agentState;
    postToAdapter({ type: 'vici2:agentState', state: agentState }, adapterOrigin);
  }, [agentState, adapterOrigin]);
}

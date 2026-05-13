// WS op → Verb mapping (M02 PLAN §8.4).
// Every WS op in the A03 protocol must appear here.
// CI gate: grep for ops that are not in this map.
//
// A03 implements:
//   socket.on('message', (raw) => { const verb = WS_OP_TO_VERB[msg.op]; ... })
//
// Missing op → 'unknown_op' response; never silently bypass RBAC.

import type { Verb } from '@vici2/types';

/**
 * Maps WebSocket operation codes to RBAC verbs.
 * Each entry must correspond to a verb in the M02 matrix.
 */
export const WS_OP_TO_VERB: Record<string, Verb> = {
  // Agent state
  'agent.pause':        'status:edit',
  'agent.unpause':      'status:edit',
  'agent.ready':        'status:edit',
  'agent.not_ready':    'status:edit',

  // Call operations
  'call.dial':          'call:dial',
  'call.transfer':      'call:transfer',
  'call.hangup':        'call:hangup',
  'call.hold':          'call:hold',
  'call.unhold':        'call:hold',

  // Supervisor monitoring
  'call.listen':        'call:listen',
  'call.whisper':       'call:whisper',
  'call.barge':         'call:barge',
  'call.eavesdrop':     'eavesdrop:any',

  // Wallboard
  'wallboard.subscribe': 'wallboard:view',

  // Callback
  'callback.claim':     'callback:edit',
  'callback.release':   'callback:edit',
};

/** Reverse map for CI: all verbs that must be covered by at least one WS op. */
export const COVERED_WS_VERBS = new Set<Verb>(Object.values(WS_OP_TO_VERB));

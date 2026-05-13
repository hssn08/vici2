// D06 — State machine: transition guard + side-effect orchestration.
//
// 4 states: PENDING | LIVE | DONE | DEAD
// 7 legal transitions (PLAN §0 bullet 3):
//   PENDING → LIVE   (worker fires)
//   PENDING → DEAD   (cancel)
//   PENDING → PENDING (snooze — callback_at rewritten)
//   LIVE → DONE     (dispo recorded)
//   LIVE → DEAD     (admin cancel, rare)
//   LIVE → PENDING  (no-answer + reschedule_24h policy)
//   PENDING → LIVE  (worker only — same as first; CAS-guarded)
//
// 5 illegal transitions (any → PENDING via direct set except snooze/reschedule,
//   DONE → anything, DEAD → anything, LIVE → PENDING except onNoAnswer)

import type { CallbackStatus } from "./schemas.js";

type TransitionKey = `${CallbackStatus}->${CallbackStatus}`;

const LEGAL_TRANSITIONS = new Set<TransitionKey>([
  "PENDING->LIVE",
  "PENDING->DEAD",
  "PENDING->PENDING",  // snooze
  "LIVE->DONE",
  "LIVE->DEAD",
  "LIVE->PENDING",     // no-answer reschedule
]);

export interface TransitionResult {
  ok: boolean;
  errorCode?: string;
}

export function guardTransition(from: CallbackStatus, to: CallbackStatus): TransitionResult {
  const key: TransitionKey = `${from}->${to}`;

  if (from === "DONE" || from === "DEAD") {
    return { ok: false, errorCode: "callback_terminal" };
  }

  if (LEGAL_TRANSITIONS.has(key)) {
    return { ok: true };
  }

  return { ok: false, errorCode: `illegal_transition_${from.toLowerCase()}_to_${to.toLowerCase()}` };
}

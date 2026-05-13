/**
 * A02 — DTMF utilities.
 *
 * Primary: RFC 4733 telephone-event via RTCDTMFSender (SIP.js sendDTMF).
 * Escape hatch: SIP INFO with application/dtmf-relay body.
 *
 * Mode toggle: useUiStore.dtmfMode ('rfc2833' | 'sip-info').
 */

import type { Session } from "sip.js";
import type { Web } from "sip.js";

export type DtmfMode = "rfc2833" | "sip-info";

/**
 * Build the SIP INFO body for DTMF relay.
 * Used when dtmfMode === 'sip-info'.
 */
export function buildDtmfInfoBody(signal: string, durationMs = 100): string {
  return `Signal=${signal}\r\nDuration=${durationMs}`;
}

/**
 * Send DTMF via SIP INFO (application/dtmf-relay body).
 * One digit per call; caller loops for multi-digit strings.
 */
export async function sendDtmfInfo(
  session: Session,
  digit: string,
): Promise<void> {
  await session.info({
    requestOptions: {
      body: {
        contentDisposition: "render",
        contentType: "application/dtmf-relay",
        content: buildDtmfInfoBody(digit),
      },
    },
  });
}

/**
 * Send DTMF using the configured mode.
 * RFC 4733 path uses SimpleUser.sendDTMF (RTCDTMFSender).
 * SIP-INFO path sends one INFO per digit with a 200 ms gap.
 */
export async function sendDtmf(
  simpleUser: Web.SimpleUser,
  digits: string,
  mode: DtmfMode = "rfc2833",
): Promise<void> {
  if (mode === "rfc2833") {
    simpleUser.sendDTMF(digits);
    return;
  }

  // SIP-INFO: send one digit at a time
  const session = (simpleUser as unknown as { session?: Session }).session;
  if (!session) {
    console.warn("[sip:dtmf] No active session for SIP-INFO DTMF");
    return;
  }
  for (const digit of digits) {
    await sendDtmfInfo(session, digit);
    await new Promise<void>((r) => setTimeout(r, 200));
  }
}

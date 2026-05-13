// I04 — Consent audit record builder.
// Produces the details_json shape stored in originate_audit for every INBOUND
// callback fire attempt. Retained per C03 audit-immutability rules.

export interface ConsentAuditRecord {
  consent_mode: "INBOUND_CALLBACK_REQUESTED";
  callback_id: string;
  original_ingroup_id: string | null;
  original_wait_seconds: number | null;
  queue_position_at_offer: number | null;
  skip_internal_dnc: boolean;
  skip_national_dnc: false;
  tcpa_outcome: string;
  tcpa_rule_applied?: string;
  party_local_time: string | null;
}

export interface TcpaResultForConsent {
  outcome: string;
  ruleApplied?: string;
  partyLocalTime?: Date;
}

/**
 * Build the consent audit record for an INBOUND callback originate attempt.
 * This is the evidential record that the customer explicitly requested the callback.
 */
export function buildConsentAuditRecord(params: {
  callbackId: bigint;
  originalIngroupId: string | null;
  originalWaitSeconds: number | null;
  queuePositionAtOffer: number | null;
  tcpaResult: TcpaResultForConsent;
}): ConsentAuditRecord {
  return {
    consent_mode: "INBOUND_CALLBACK_REQUESTED",
    callback_id: String(params.callbackId),
    original_ingroup_id: params.originalIngroupId,
    original_wait_seconds: params.originalWaitSeconds,
    queue_position_at_offer: params.queuePositionAtOffer,
    skip_internal_dnc: true,    // express consent overrides internal DNC
    skip_national_dnc: false,   // National DNC is NEVER bypassed
    tcpa_outcome: params.tcpaResult.outcome,
    tcpa_rule_applied: params.tcpaResult.ruleApplied,
    party_local_time: params.tcpaResult.partyLocalTime
      ? params.tcpaResult.partyLocalTime.toISOString()
      : null,
  };
}

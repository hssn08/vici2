// Package picker implements E04 — lead-claim, dispatch, and agent/lead
// pairing for outbound campaigns.
//
// E04 PLAN §1: E04 is the picker — "who and how" of every outbound dial.
// E02 publishes the budget (dispatch_tokens); E04 claims leads, optionally
// reserves agents, calls T04.Originate, and maps outcomes to E01.Release.
package picker

import "errors"

// ErrNoTokens is returned when the dispatch_tokens key is missing (E02 down
// or TTL expired) or when the DECR result is nil. E04 must not originate
// without budget — correct safety posture per PLAN §3.1.
var ErrNoTokens = errors.New("picker: no dispatch tokens (E02 down or key expired)")

// ErrHopperEmpty is returned when claim_lead_from_hopper.v1.lua returns nil
// (hopper ZSET is empty for the campaign). E04 publishes a refill_request
// pubsub and skips the tick.
var ErrHopperEmpty = errors.New("picker: hopper empty for campaign")

// ErrNoReadyAgent is returned by PickForCall when pick_agent_for_call.v1.lua
// returns 0 (no READY agent in the campaign ZSET). PROGRESSIVE mode skips
// the dispatch and INCRs the token back.
var ErrNoReadyAgent = errors.New("picker: no READY agent available")

// ErrCampaignPaused is returned by the pre-T04 campaign-active check.
var ErrCampaignPaused = errors.New("picker: campaign is paused or inactive")

// ErrLeadIneligible is returned when the lead's Valkey HASH status is not
// dial-eligible (became DNC/dropped between E01 filler-fill and E04 pop).
var ErrLeadIneligible = errors.New("picker: lead is no longer dial-eligible")

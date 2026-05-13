// Package tz implements the D03 6-tier timezone resolver.
// Confidence is a frozen public interface — no changes without an RFC.
package tz

// Confidence represents the resolver's certainty level for a timezone result.
// Consumed by C01 (TCPA gate), D02 (import tagging), E01 (hopper), T04 (originate).
type Confidence string

const (
	// ConfKnown — lead.known_timezone was present and valid (highest confidence).
	ConfKnown Confidence = "KNOWN"
	// ConfZIP — ZIP centroid → IANA mapping from zip_codes table.
	ConfZIP Confidence = "ZIP"
	// ConfNXX — NPA+NXX hit in phone_codes or phone_codes_overrides.
	ConfNXX Confidence = "NXX"
	// ConfNPA — NPA-only fallback (first IANA per NPA) or libphonenumber.
	ConfNPA Confidence = "NPA"
	// ConfStateDefault — single-tz state default (excluded for 8 split states).
	ConfStateDefault Confidence = "STATE_DEFAULT"
	// ConfCampaignDefault — admin-set campaign default (last-chance fallback).
	ConfCampaignDefault Confidence = "CAMPAIGN_DEFAULT"
	// ConfNone — all tiers exhausted; C01 decides BLOCK vs ALLOW_WARN.
	ConfNone Confidence = "NONE"
)

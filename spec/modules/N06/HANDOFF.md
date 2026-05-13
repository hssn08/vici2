# Module N06 — FCC Reassigned Numbers DB Scrub — HANDOFF

| Field | Value |
|---|---|
| Module | N06 |
| Status | NOT_STARTED |
| Handoff date | TBD (post-implementation) |

## Summary

N06 integrates vici2 with the FCC Reassigned Numbers Database (reassigned.us). It batch-queries phone numbers before campaign launch, stores results in `rnd_lookup_log` for TCPA §64.1200(f)(13) audit compliance, and inserts `source='reassigned'` rows into the `dnc` table — auto-excluding flagged numbers from the E01 hopper.

## Key Entry Points

- **API client**: `api/src/integrations/rnd/client.ts` — `RndClient.query(items)` is the main integration point
- **Worker job**: `workers/src/jobs/rnd-scrub/processor.ts` — BullMQ job named `rnd-scrub`
- **Trigger API**: `POST /api/admin/rnd/scrub` — admin-triggered scrub
- **Status API**: `GET /api/admin/rnd/status/:campaign_id` — scrub progress polling
- **Config API**: `GET/PUT /api/admin/rnd/config` — tenant RND credential management

## How E01 Reads Reassigned Numbers

No code change in E01 is required. The hopper filler calls `DncService.isDnc()` with all enabled sources. Once N06 inserts `source='reassigned'` rows into the `dnc` table and populates `t:{tid}:dnc:reassigned:bloom` in Valkey, these numbers are automatically excluded on the next hopper fill cycle (≤30 seconds).

## Cost Reporting

`GET /api/admin/rnd/usage?year=2026&month=5` returns monthly query count, estimated cost, and budget status. The `rnd_usage_log` table is updated after every batch of queries.

## Safe-Harbor Evidence

Every RND query is logged in `rnd_lookup_log` with `consent_date`, `consent_date_src`, `result`, `disconnect_date`, and `lookup_date`. These records are the TCPA §64.1200(f)(13) evidence — retained 5 years via C04's partition archival.

## Open Implementation Notes

- SFTP file-upload mode (`query_mode='sftp'`) for >50K phones requires SSH key provisioning with reassigned.us
- `rnd:override` (super_admin only) bypasses reassigned DNC; always requires written justification
- `no_data_policy` tenant setting controls whether `No Data` responses block numbers (default: `safe` = allow)

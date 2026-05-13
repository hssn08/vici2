# M08 — Compliance Reporting — PLAN

**Module:** M08
**Status:** PLAN
**Date:** 2026-05-13
**Branch:** feat/M08-implement
**Depends on:** D04 (canonical drop-rate denominator + SUM(human_answered)), C01 (call_window_audit), C02 (consent_log), C03 (audit_attestation + hash chain), D05 (dnc_sync_log)

---

## 0. TL;DR (8 bullets)

1. **M08 is read-only.** All queries use `vici2_audit_reader` pattern (no writes); no schema changes beyond the existing D04/C01/C02/C03/D05 tables.
2. **FCC drop-rate denominator is exactly `SUM(s.human_answered)` — never `COUNT(*)`**, per D04 PLAN §8.2. CI grep (`check-drop-rate-denominator.sh`) enforces this. M08 re-uses the canonical SQL verbatim.
3. **Four reporting endpoints** under `/api/admin/reports/`:
   - `GET /fcc-drop-rate` — per-campaign rolling 30-day FCC 3% drop-rate report
   - `GET /fcc-drop-rate/timeline` — daily buckets, last 90 days
   - `GET /evidence-pack?call_uuid=X` — TCPA evidence pack (originate_audit + call_window_audit + dnc (via call_log) + consent_log + audit_log rows)
   - `GET /dnc-sync-history` — per-tenant federal/state/internal sync history from dnc_sync_log
   - `GET /attestations` — list audit_attestation rows for download/verification
   - `GET /fcc-drop-rate/export.csv` — CSV download for FCC quarterly safe-harbor evidence
4. **RBAC:** all endpoints require `report:view`; export endpoints additionally require `report:export`. Both `admin` and `viewer` roles already have these verbs in the RBAC matrix.
5. **Evidence pack is assembled from 5 tables** scoped to a single `call_uuid`: originate_audit (gate decisions), call_window_audit (TCPA check), consent_log (recording consent), dnc table (DNC status at call time via originate_audit.dnc_decision), audit_log (disposition + any other action rows).
6. **CSV export** streams stringified rows; uses `csv-stringify` (already in package.json). Filename: `fcc_drop_rate_{campaign}_{from}_{to}.csv`.
7. **Prometheus metrics:** 4 counters (report_requests_total by endpoint, export_bytes_total, evidence_pack_requests_total, missing_call_uuid_total).
8. **Tests:** 1 unit test file (query builder / metric formula), 1 integration-style golden test (mock Prisma, validate FCC row count and denominator expression), 1 CI assertion (denominator grep pass).

---

## 1. Files to create

```
api/src/reporting/
  index.ts              — Fastify route registration
  service.ts            — ReportingService (all query logic)
  handlers/
    fcc-drop-rate.ts    — GET /fcc-drop-rate + /timeline
    evidence-pack.ts    — GET /evidence-pack
    dnc-sync-history.ts — GET /dnc-sync-history
    attestations.ts     — GET /attestations
    fcc-export.ts       — GET /fcc-drop-rate/export.csv
  metrics.ts            — Prometheus counters

api/test/reporting/
  service.test.ts       — unit tests: formula, denominator parity, query shape
  golden.test.ts        — golden FCC row count integration test (mock Prisma)
```

---

## 2. API surface

| Method | Path | RBAC verb | Notes |
|---|---|---|---|
| GET | `/api/admin/reports/fcc-drop-rate` | `report:view` | `?campaign=X&from=Y&to=Z` (ISO dates, default 30d) |
| GET | `/api/admin/reports/fcc-drop-rate/timeline` | `report:view` | `?campaign=X&days=90` daily buckets |
| GET | `/api/admin/reports/fcc-drop-rate/export.csv` | `report:export` | CSV; streams |
| GET | `/api/admin/reports/evidence-pack` | `report:view` | `?call_uuid=X` |
| GET | `/api/admin/reports/dnc-sync-history` | `report:view` | `?source=X&limit=100` |
| GET | `/api/admin/reports/attestations` | `report:view` | `?table=X&from=Y&to=Z` |

---

## 3. Canonical FCC drop-rate SQL (from D04 PLAN §8.2 — do NOT alter denominator)

```sql
SELECT
    SUM(s.sale)                               AS sales,
    SUM(s.human_answered)                     AS human_answered,  -- FCC denominator
    SUM(s.human_answered AND cl.is_drop = 1)  AS drops,
    COUNT(*)                                  AS total_calls,
    cl.campaign_id
FROM call_log cl
JOIN statuses s
  ON s.tenant_id = cl.tenant_id
 AND s.campaign_id = '__SYS__'
 AND s.status = cl.status
WHERE cl.tenant_id = ?
  AND cl.campaign_id = ?
  AND cl.call_started >= NOW() - INTERVAL ? DAY
GROUP BY cl.campaign_id;
```

Drop rate = `drops / NULLIF(human_answered, 0)`. Alert threshold: > 3% (FCC TCPA safe-harbor).

---

## 4. Evidence pack query targets

For a given `call_uuid`, assemble:
- `originate_audit WHERE call_uuid = ?` — gate decisions (TCPA, DNC, consent)
- `call_window_audit WHERE call_uuid = ?` — TCPA window checks
- `consent_log WHERE call_uuid = ?` — recording consent rows
- `audit_log WHERE entity_id = call_uuid OR (action LIKE 'lead.status%' AND entity_id = lead_id)` — disposition trail
- `dnc_sync_log` — most recent sync run per source (contextual, not per-call)

All rows include `prev_hash` / `row_hash` / `hash_at` for C03 chain verification.

---

## 5. Test plan

- **Unit:** `service.test.ts` — mock Prisma, assert drop-rate formula, verify SUM(human_answered) in SQL string, assert CSV header row
- **Golden:** `golden.test.ts` — mock returns 5 human_answered rows, 1 drop row → assert drop_rate = 0.2 (1/5), row_count = 5
- **CI:** `check-drop-rate-denominator.sh` already guards the directory; M08 files must pass

---

End of PLAN.md.

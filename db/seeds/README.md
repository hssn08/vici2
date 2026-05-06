# `db/seeds/` — Reference data CSVs

These CSV files are loaded by `api/prisma/seed.ts` (`make db-seed`).
They are committed to the repo so every `make db-reset && make db-seed`
yields a deterministic dev DB.

## Contents

| File | Purpose | Owner | Rows in starter | Full set |
|---|---|---|---|---|
| `phone_codes_starter.csv` | NANP NPA + NXX → IANA timezone | F02 (D03 owns refresh) | 20 | ~165k after D03 IMPLEMENT pipeline |
| `zip_codes_starter.csv`   | US ZIP → IANA timezone (D03 tier 2 cascade) | F02 (D03 owns refresh) | 20 | ~33k US ZIPs after D03 IMPLEMENT pipeline |

Each starter CSV is a representative sample covering the eight US split
states (IN, KY, TN, FL, ID, OR, ND, SD, NE) called out in
[D03 RESEARCH §6.1](../../spec/modules/D03/RESEARCH.md#61-the-eight-split-states)
plus a handful of single-tz states for sanity.

## Format — `phone_codes_starter.csv`

```
area_code,exchange_code,state,county,tz_iana,confidence
317,555,IN,Marion,America/Indiana/Indianapolis,NXX
```

- `area_code` `CHAR(3)` — NANP NPA (3 digits, no dashes).
- `exchange_code` `CHAR(3)` — NANP NXX (3 digits, no dashes).
- `state` `CHAR(2)` nullable — USPS / CA-province two-letter code.
- `county` `VARCHAR(64)` nullable — county / borough name.
- `tz_iana` `VARCHAR(40)` — canonical IANA timezone identifier
  (e.g. `America/Indiana/Indianapolis`, `America/Phoenix`,
  `Pacific/Honolulu`). Never a numeric offset.
- `confidence` `ENUM('NPA','NXX')` — `NXX` when the row is NPA-NXX
  granular, `NPA` when only the area code is meaningful.

## Format — `zip_codes_starter.csv`

```
zip,tz_iana,state,confidence
46201,America/Indiana/Indianapolis,IN,ZIP
```

- `zip` `CHAR(5)` — 5-digit US ZIP.
- `tz_iana` `VARCHAR(40)` — canonical IANA timezone.
- `state` `CHAR(2)` nullable.
- `confidence` `ENUM('ZIP')` — always `ZIP`.

## Refresh pipeline (D03 owns; F02 ships starter only)

The full ~165k-row `phone_codes` table and ~33k-row `zip_codes` table are
NOT committed to the repo. Phase-1 dev runs against the starter CSVs
above. Production deployments run the D03 build pipeline:

1. **Annual NANPA refresh** (Q1 cron): `scripts/build-phone-codes.sh`
   pulls the NANPA Central Office Code Utilized Report per state,
   joins LCG rate-center data for split-state NXX disambiguation, runs
   the curated county→IANA crosswalk in
   `db/seeds/split_state_counties.csv` (D03 IMPLEMENT will add), and
   writes `db/seeds/phone_codes.csv` (~165k rows, ~10 MB).
2. **Quarterly LCG refresh** (monthly cron): refreshes split-state
   rate-center mappings.
3. **`make db-seed`** UPSERTs the CSV into MySQL idempotently.

For the ZIP table the build is one-shot: Census ZCTA Gazetteer +
`evansiroky/timezone-boundary-builder` polygons → point-in-polygon →
`db/seeds/zip_codes.csv`. Refreshed when IANA tzdata releases (~2× per
year).

See [D03 RESEARCH §5](../../spec/modules/D03/RESEARCH.md) for the full
ingestion pipeline diagram.

## Manual overrides

The `phone_codes_overrides` table (same shape as `phone_codes` plus
`reason`, `created_by_user_id`) carries per-customer manual overrides
that win over the global table at lookup time. There is no starter CSV
for overrides — they are inserted by the M03 admin UI at runtime.

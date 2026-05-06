# vici2 — REST API contract

Canonical OpenAPI document: [`shared/openapi/openapi.yaml`](../shared/openapi/openapi.yaml).

## Cross-cutting decisions

These are non-negotiable defaults every API module must follow:

- All requests are JSON unless explicitly streaming or multipart.
- Auth: JWT bearer (RS256). Tenant ID lives in JWT claims.
- Errors: `{ error: { code, message, details? } }` with stable string `code`.
- Pagination: cursor-based (`?cursor=…&limit=…`); never offset for tables
  > 10 k rows.
- Timestamps: ISO-8601 strings in responses; epoch millis in events.
- Idempotency: state-changing endpoints accept an `Idempotency-Key` header.

## Module ownership

| Path prefix | Module |
|---|---|
| `/health` | F01 |
| `/auth/*` | F05 |
| `/agent/*` | A04, A05, A06, A07, A08, A09 |
| `/admin/*` | M02 - M08 |
| `/sup/*` | S01 - S04 |
| `/external/*` | N01 |

Each module that adds endpoints must update `shared/openapi/openapi.yaml` in
the same PR.

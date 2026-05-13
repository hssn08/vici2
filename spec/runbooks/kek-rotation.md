# KEK Rotation Runbook

**Version:** 1.0 (O05 Phase 1)
**Date:** 2026-05-13
**Type:** Rewrap-only — application ciphertext is NEVER read or written.
**API:** Calls F05's `encryption.rewrapAll()` (F05 PLAN §4.6)
**Cadence:** Routine 12 months; Emergency <24h
**Estimated time:** ~5k rows/sec on dev; production may vary

---

## Overview

vici2 uses envelope encryption (F05 PLAN §4): each encrypted database row
stores a per-row Data Encryption Key (DEK) wrapped by the Key Encryption Key
(KEK). Rotation is rewrap-only: decrypt the DEK with the old KEK, re-wrap
with the new KEK. Application ciphertext (`payload_ct`) is never touched.

This pattern is safe to run online (services continue serving traffic) because
during the rotation window both old and new KEKs are loaded in env, so any row
can be decrypted regardless of which KEK version it uses.

---

## Pre-rotation Checklist

- [ ] Confirm rotation trigger: routine (>12mo) or emergency (<24h)
- [ ] Notify on-call via PagerDuty + `#ops-announce` (routine only; skip for emergency)
- [ ] Verify you have access to the production vault / SSM Parameter Store
- [ ] Confirm no active deploy is in progress (check CI/CD pipeline)
- [ ] Estimate row count (Step 4 dry-run will do this formally)

---

## Rotation Steps

### Step 1: Pre-flight — snapshot and estimate

```bash
# Snapshot MySQL (non-blocking for InnoDB)
mysqldump --single-transaction --quick \
  -u "${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" \
  > /tmp/vici2_pre_kek_rotation_$(date +%Y%m%d_%H%M%S).sql.gz

# Snapshot Valkey (flush in-flight refresh tokens to disk first)
valkey-cli BGSAVE
sleep 3
cp /var/lib/docker/volumes/vici2_valkey_data/_data/dump.rdb \
   /tmp/valkey_pre_kek_rotation_$(date +%Y%m%d_%H%M%S).rdb

# Verify count of rows needing rotation (informational; dry-run gives exact count)
mysql -u "${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" \
  -e "SELECT kek_version, COUNT(*) as count FROM sip_credentials GROUP BY kek_version;
      SELECT kek_version, COUNT(*) as count FROM carrier_gateways GROUP BY kek_version;
      SELECT kek_version, COUNT(*) as count FROM totp_secrets GROUP BY kek_version;"
```

No state change in Step 1. This is pure observation.

---

### Step 2: Generate the new KEK

```bash
# N = current version (check VICI2_KEK_CURRENT_VERSION in SSM/vault)
# Replace N+1 below with the new version number
NEW_KEK=$(openssl rand -base64 32)
echo "VICI2_KEK_V${N_PLUS_ONE}: ${NEW_KEK}"

# Store in vault BEFORE updating env (rollback safety)
# AWS SSM:
aws ssm put-parameter \
  --name "/vici2/prod/VICI2_KEK_V${N_PLUS_ONE}" \
  --value "${NEW_KEK}" \
  --type SecureString \
  --key-id "alias/vici2-ssm-kek" \
  --overwrite

# Also archive in cold storage for backup decryption safety:
# vault kv put secret/vici2/kek_archive/v${N_PLUS_ONE} key="${NEW_KEK}" created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

---

### Step 3: Deploy with both KEKs present

Add BOTH env vars to the running environment. Services will be able to
decrypt rows encrypted with either version.

```bash
# Update SSM parameters:
aws ssm put-parameter --name "/vici2/prod/VICI2_KEK_CURRENT_VERSION" \
  --value "${N_PLUS_ONE}" --type String --overwrite

# Both old and new KEKs must be present:
# VICI2_KEK_V{N}     = <old key>   (already in SSM)
# VICI2_KEK_V{N+1}   = <new key>   (just added in Step 2)
# VICI2_KEK_CURRENT_VERSION = N+1

# Rolling restart (new containers pick up both env vars):
docker compose pull api workers dialer
docker compose up -d --no-deps api workers dialer
```

Wait for all containers to pass healthchecks before proceeding:

```bash
docker compose ps
# All services should show "healthy"
```

---

### Step 4: Dry run — estimate row count and time

```bash
make rewrap-keks DRY_RUN=true FROM=${N} TO=${N_PLUS_ONE}
# Or directly:
docker compose run --rm api pnpm tsx scripts/kek-rewrap.ts \
  --dry-run --from=${N} --to=${N_PLUS_ONE} --batch=500

# Expected output:
# Would rewrap: 12,847 rows across 3 tables
# Estimated time: ~3s at 5000 rows/sec
# Tables: sip_credentials (8412), carrier_gateways (23), totp_secrets (4412)
# Errors: 0
```

If `Errors > 0`: investigate the flagged rows before proceeding. Do NOT run
the live sweep with errors in dry-run output.

---

### Step 5: Execute the rewrap sweep

The sweep is **idempotent** (`WHERE kek_version < N+1`). If it crashes
mid-run, re-run from the beginning — it will skip already-rotated rows.

```bash
make rewrap-keks FROM=${N} TO=${N_PLUS_ONE}
# Or directly:
docker compose run --rm api pnpm tsx scripts/kek-rewrap.ts \
  --from=${N} --to=${N_PLUS_ONE} --batch=500 --commit

# Monitor progress (tails the rewrap log):
docker compose logs -f api | grep kek-rewrap
```

What the sweep does per row (F05 encryption.ts::rewrapAll):
1. `plaintext_dek = AES_GCM_256_unwrap(wrapped_dek, KEK[row.kek_version])`
2. `new_wrapped_dek = AES_GCM_256_wrap(plaintext_dek, KEK_V{N+1})`
3. `UPDATE row SET wrapped_dek_ct=new_wrapped_dek, kek_version={N+1} WHERE id=?`
4. `payload_ct` (application ciphertext) is NEVER read or written

---

### Step 6: Verify — all rows on new version

```bash
mysql -u "${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" \
  -e "SELECT kek_version, COUNT(*) as count FROM sip_credentials GROUP BY kek_version;
      SELECT kek_version, COUNT(*) as count FROM carrier_gateways GROUP BY kek_version;
      SELECT kek_version, COUNT(*) as count FROM totp_secrets GROUP BY kek_version;"
```

**Required output:** Only rows with `kek_version = N+1`. If ANY row still has
`kek_version < N+1`, re-run Step 5. The sweep is safe to re-run.

---

### Step 7: Compliance hold (routine rotation only)

**Routine rotation:** Wait 30 days before dropping the old KEK from env.
This ensures that any in-flight backup can still be decrypted with the old
key during the hold period.

**Emergency rotation:** Skip the 30-day wait. Drop the old KEK immediately
after Step 6 verification. Accept that backups taken with the old KEK may
require the archived key to decrypt.

After the hold period (or immediately in emergency):

```bash
# Remove old KEK from env:
aws ssm delete-parameter --name "/vici2/prod/VICI2_KEK_V${N}"

# Rolling restart without the old KEK:
docker compose up -d --no-deps api workers dialer
```

---

### Step 8: Archive old KEK and emit audit event

```bash
# Archive to cold storage (NOT deleted — backups encrypted with old KEK may need it)
# vault kv put secret/vici2/kek_archive/v${N} \
#   key="<old_kek_value>" \
#   rotated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#   rotation_reason="routine|emergency"

# Emit audit event
mysql -u "${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" \
  -e "INSERT INTO audit_event (kind, actor, tenant_id, payload, created_at)
      VALUES (
        'auth.kek.rotation_completed',
        'ops-kek-rotation',
        1,
        JSON_OBJECT(
          'from_version', ${N},
          'to_version', ${N_PLUS_ONE},
          'rows_rewrapped', (SELECT COUNT(*) FROM sip_credentials WHERE kek_version=${N_PLUS_ONE}),
          'rotation_type', 'routine',
          'completed_at', NOW()
        ),
        NOW()
      );"
```

---

## Rollback Paths

| Stage | Situation | Rollback Action |
|---|---|---|
| Step 4 dry-run errors | Errors > 0 | Do NOT proceed to Step 5. Investigate flagged rows. No state has changed. |
| Step 5 partial failure | Sweep crashes mid-run | Re-run Step 5. Sweep is idempotent on `WHERE kek_version < N+1`. Safe to restart. |
| Step 7 done, unrewrapped row found | Backup restore surfaces old-version rows | Re-add old KEK to env (`VICI2_KEK_V{N}=<archived_value>`), rolling restart, re-run Step 5, drop again. |
| New KEK suspected compromised mid-rotation | Possible leak of KEK V{N+1} | Stop sweep. Generate `VICI2_KEK_V{N+2}`. Restart from Step 2 with N+2. Both V{N} and V{N+1} remain in env until V{N+2} sweep completes. |
| Step 3 rolling restart fails | Health checks fail after env update | Revert env to only `VICI2_KEK_V{N}` and `VICI2_KEK_CURRENT_VERSION={N}`. Rolling restart. Rows rotated in Step 5 (if any) remain at V{N+1} but decrypt with V{N} fallback. |

---

## Emergency Rotation Differences

In an emergency (suspected KEK leak, contributor offboarding with exposure):

1. **Skip the 30-day hold** (Step 7) — drop old KEK immediately after verification
2. **Force-reset all agent SIP passwords** after rotation (they were encrypted with old KEK)
3. **Rotate carrier credentials** (also encrypted with old KEK)
4. **Notify all engineers** who had access to the old KEK
5. **Emit** `audit_event (kind='auth.kek.emergency_rotation')` instead of `rotation_completed`
6. **SLA:** Complete within 24 hours of suspected leak

---

## JWT Key Rotation (separate runbook)

JWT signing keys rotate quarterly (more frequently than KEKs). See
`spec/runbooks/jwt-key-rotation.md` for the procedure. The pattern is similar
(dual-key grace period) but uses JWKS multi-key arrays rather than kek_version
columns.

---

## Cert Renewal (see cert-renewal.md)

Certificate renewal (LE wildcard via certbot) is automated and does not
require this runbook. See `spec/runbooks/cert-renewal.md` for manual
override and troubleshooting.

# Security Incident — Operator Checklist

**Terse version for active incidents. Full plan:** `docs/security/incident-response.md`

---

## Severity Quick-Pick

- **P0** — Active breach (confirmed unauthorized access, active fraud, live exfiltration)
- **P1** — Suspected breach (anomaly, credible tip, unusual pattern)
- **P2** — Hardening gap (vuln found, not exploited)

---

## First 5 Minutes (all severities)

```bash
# 1. Open incident channel: #sec-ir-active (private, invite responders only)
# 2. Declare severity, assign IC and Scribe
# 3. PRESERVE EVIDENCE BEFORE ROTATING ANYTHING

# Snapshot audit_event for incident window
mysql -u "${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" \
  -e "SELECT * FROM audit_event WHERE created_at > NOW() - INTERVAL 2 HOUR \
      ORDER BY created_at DESC LIMIT 500" > /tmp/audit_snap_$(date +%Y%m%d_%H%M%S).json

# Export Caddy access log (last 2h)
sudo tail -n 50000 /var/log/caddy/access.log | \
  jq '. | select(.ts > (now - 7200))' > /tmp/caddy_access_$(date +%Y%m%d_%H%M%S).json

# Export FS log (last 2h)
sudo journalctl -u freeswitch --since "2 hours ago" > /tmp/fs_log_$(date +%Y%m%d_%H%M%S).txt
```

---

## Playbook: JWT Key Compromise

```bash
# 1. Preserve evidence (above)
# 2. Generate new JWT key pair
make gen-jwt-keys
# 3. Update VICI2_JWT_PRIVATE_KEY_JWK + VICI2_JWT_PUBLIC_KEYS_JWKS in SSM
# 4. Rolling restart
docker compose up -d --no-deps api
# 5. Revoke ALL refresh tokens (forces re-login for everyone)
valkey-cli -h 127.0.0.1 FLUSHDB 0
# 6. Remove old public key from JWKS after 15min (access token TTL)
# 7. Audit event
mysql ... -e "INSERT INTO audit_event (kind, actor, payload, created_at) VALUES ('security.jwt.emergency_rotation', 'ops', '{}', NOW());"
```

---

## Playbook: KEK Compromise

```bash
# 1. Preserve evidence (above)
# 2. Generate new KEK
NEW_KEK=$(openssl rand -base64 32)
# 3. Store in SSM, deploy with both KEKs, rotation sweep
# See spec/runbooks/kek-rotation.md (emergency path — skip 30-day hold)
make rewrap-keks FROM=${OLD_VERSION} TO=${NEW_VERSION}
# 4. After verification, force-reset agent SIP passwords + carrier creds
# 5. Emit audit event: kind='auth.kek.emergency_rotation'
```

---

## Playbook: SIP Credential Compromise (single agent)

```bash
# 1. Identify affected agent from CDR
# 2. Rotate SIP password via admin API
curl -X POST https://api.vici2.example.com/admin/agents/${AGENT_ID}/rotate-sip-credentials \
  -H "Authorization: Bearer ${ADMIN_JWT}"
# 3. Flush FS registration for that extension
fs_cli -H 127.0.0.1 -P 8021 -p "${FS_EVENT_SOCKET_PASSWORD}" \
  -x "sofia profile internal flush_inbound_reg ${EXT}@${DOMAIN}"
# 4. Ban source IP
sudo fail2ban-client set freeswitch banip ${ATTACKER_IP}
```

---

## Playbook: Carrier Credential Compromise (toll fraud — time-critical!)

```bash
# IMMEDIATE: disable the carrier gateway
mysql -u "${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" \
  -e "UPDATE carrier_gateways SET enabled=0 WHERE id=${CARRIER_ID};"
# Then call carrier NOC to report fraud and request call-stop
# After confirmed: rotate creds via admin UI, re-enable gateway
```

---

## Playbook: S3 Bucket Public Access

```bash
# Block public access immediately
aws s3api put-public-access-block \
  --bucket "vici2-recordings-prod-1" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
# Check CloudTrail for what was accessed
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=vici2-recordings-prod-1 \
  --start-time "$(date -d '24 hours ago' --iso-8601=seconds)" \
  --query 'Events[].{Time:EventTime,User:Username,Event:EventName}'
```

---

## All-Clear Criteria

IC signs off when:
1. Unauthorized access confirmed stopped
2. Root cause identified (not just "we rotated everything")
3. Monitoring clean for 1 hour
4. Post-mortem ticket filed (due within 5 business days)

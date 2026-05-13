# Certificate Renewal Runbook

**Version:** 1.0 (O05 Phase 1)
**Date:** 2026-05-13
**Owner:** O05 / SRE

---

## Normal Operation (Automated)

Under normal operation, certificates renew automatically:

- **LE wildcard cert** (`*.vici2.example.com`): certbot Snap-managed systemd
  timer runs `certbot renew` twice daily. Renewal only happens when expiry
  is <30 days. On renewal, `render-fs-tls.sh` is called automatically.
- **Caddy** (Phase 1): loads cert from `/etc/letsencrypt/live/` via Caddyfile.
  Caddy reads the file on startup; `systemctl reload caddy` re-reads on demand.

**No manual action required if the monitoring alert (`CertExpiresSoon` at <14d)
does not fire.**

---

## 1. Verify Current Cert Status

```bash
# Check the cert on HTTPS
echo | openssl s_client -connect staging.vici2.example.com:443 -servername staging.vici2.example.com 2>/dev/null \
  | openssl x509 -noout -dates

# Check the cert on FS SIP-TLS
echo | openssl s_client -connect staging.vici2.example.com:5061 2>/dev/null \
  | openssl x509 -noout -dates

# Check the cert on WSS:7443
echo | openssl s_client -connect staging.vici2.example.com:7443 2>/dev/null \
  | openssl x509 -noout -dates

# Check certbot's view of the cert
sudo certbot certificates
```

---

## 2. Force Renewal (Manual Override)

Use this if the auto-renew failed (e.g., DNS provider creds expired, network
issue during renewal window).

```bash
# Dry run first
sudo certbot renew --dry-run

# Force renewal (ignore 30-day threshold)
sudo certbot renew --force-renewal

# Verify the new cert
sudo certbot certificates
ls -la /etc/letsencrypt/live/vici2.example.com/
```

After a successful forced renewal, the `--deploy-hook` (`render-fs-tls.sh`)
runs automatically and restarts FreeSWITCH sofia profiles.

---

## 3. Reload Caddy After Cert Change

Caddy reads the cert file on startup. After a cert renewal, reload Caddy to
pick up the new cert without a full restart:

```bash
sudo systemctl reload caddy
# or
sudo caddy reload --config /etc/caddy/Caddyfile --force
```

Verify Caddy is serving the new cert:
```bash
echo | openssl s_client -connect staging.vici2.example.com:443 2>/dev/null \
  | openssl x509 -noout -dates
```

---

## 4. FreeSWITCH TLS Refresh

If FS-side cert files (`wss.pem`, etc.) are stale (e.g., render-fs-tls.sh
failed during last renewal), manually rerun the deploy hook:

```bash
# Set RENEWED_LINEAGE so the script knows where the cert lives
sudo RENEWED_LINEAGE=/etc/letsencrypt/live/vici2.example.com \
  FS_EVENT_SOCKET_PASSWORD="${FS_EVENT_SOCKET_PASSWORD}" \
  /usr/local/bin/render-fs-tls.sh

# Verify the FS-side cert files were updated
ls -la /etc/freeswitch/tls/
openssl x509 -noout -dates -in /etc/freeswitch/tls/wss.pem
```

---

## 5. DNS Provider Credential Rotation

If Route53 credentials expire (AWS access key rotation), update them before
the next renewal:

```bash
# Update in SSM
aws ssm put-parameter --name "/vici2/prod/AWS_ACCESS_KEY_ID" \
  --value "<new_key>" --type SecureString --overwrite
aws ssm put-parameter --name "/vici2/prod/AWS_SECRET_ACCESS_KEY" \
  --value "<new_secret>" --type SecureString --overwrite

# Test DNS-01 challenge manually
sudo certbot renew --dry-run --dns-route53
```

In production, prefer IAM instance role over static credentials (no expiry).

---

## 6. Monitoring

**Prometheus alerts** (O01 rules, owned by O05 §8.2):

| Alert | Threshold | Action |
|---|---|---|
| `CertExpiresSoon` | <14d remaining | Page on-call; force renew within 2 days |
| `CertExpiresVerySoon` | <3d remaining | P0 incident; renew immediately |
| `CaddyACMERenewalFailing` | >0 failures in 6h | Investigate DNS provider creds + certbot logs |

**Manual check:**
```bash
# Certbot log (most recent renewal attempt)
sudo journalctl -u snap.certbot.renew.service -n 50

# Caddy log
sudo journalctl -u caddy.service -n 50
sudo tail -50 /var/log/caddy/caddy.log
```

---

## 7. Emergency: Cert Expired

If the cert expires before renewal completes (should not happen with 14-day
alert, but included for completeness):

1. Immediately force-renew: `sudo certbot renew --force-renewal`
2. If certbot fails: check DNS provider API status; verify `AWS_ACCESS_KEY_ID`
   is valid and has Route53 access
3. If DNS-01 is unavailable: temporarily configure Caddy with a self-signed
   cert to keep the service up while troubleshooting (do NOT use in production
   beyond emergency recovery period)
4. Once renewed, reload Caddy and restart FS sofia profiles
5. Emit incident ticket and post-mortem if outage occurred

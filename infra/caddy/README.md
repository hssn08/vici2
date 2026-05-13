# Caddy — Edge TLS Termination

## Phase 1 (current): host-installed

Caddy 2.9 runs as a **systemd service on the host**, proxying HTTPS:443 and
WSS:7443 to the compose stack's loopback-bound ports.

```
Internet → Caddy (:443, :7443) → api:3000 / web:4000 / freeswitch:5066
```

### Single-cert layout

certbot owns the Let's Encrypt wildcard cert and writes to
`/etc/letsencrypt/live/`. Caddy loads the cert from disk via the `tls` path
directive in `Caddyfile`. This keeps a single ACME account hitting Let's
Encrypt — Caddy's own ACME is disabled (`auto_https off`).

FreeSWITCH-side TLS (`wss.pem`, `agent.pem`, etc.) is written by
`infra/certbot/render-fs-tls.sh` on each renewal.

### Install

```bash
# 1. Install certbot and issue the cert first
sudo bash infra/certbot/install.sh

# 2. Build and install Caddy with Route53 DNS plugin
sudo bash infra/caddy/install.sh

# 3. Edit the generated config files
sudo nano /etc/caddy/Caddyfile
sudo nano /etc/caddy/caddy.env

# 4. Start
sudo systemctl start caddy
sudo journalctl -u caddy -f
```

### Validate config without restarting

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
```

### Reload after config change

```bash
sudo systemctl reload caddy
# or
sudo caddy reload --config /etc/caddy/Caddyfile --force
```

## Phase 2 (deferred): Caddy inside compose

When the next round of compose work happens, Caddy will move into a compose
service on the `edge` docker network (F01 amendment). The `Caddyfile.example`
reverse-proxy upstreams change from `127.0.0.1:PORT` to `api:3000`,
`web:4000`, etc.

## Cert-expiry alerting

Caddy exposes Prometheus metrics at `http://127.0.0.1:2019/metrics`. The
`caddy_certificates_expiry_seconds` gauge is scraped by O01's Prometheus. See
`infra/observability/prometheus/rules/` for the `CertExpiresSoon` alert.

For FreeSWITCH-side cert expiry, blackbox_exporter probes `fs:5061` daily and
exports `probe_ssl_earliest_cert_expiry`.

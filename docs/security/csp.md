# Content Security Policy (CSP) — vici2

**Version:** 1.0 (O05 Phase 1)
**Date:** 2026-05-13
**Owner:** O05 (served via Caddy `header` directive)
**Caddyfile:** `infra/caddy/Caddyfile.example`

---

## Current CSP Header

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' wss://*.vici2.example.com;
  media-src 'self' blob:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  upgrade-insecure-requests
```

---

## Directive Rationale

| Directive | Value | Reason |
|---|---|---|
| `default-src` | `'self'` | Deny everything not explicitly allowed |
| `script-src` | `'self'` | No `unsafe-eval`, no `unsafe-inline`; Next.js 14 standalone compatible |
| `style-src` | `'self' 'unsafe-inline'` | `unsafe-inline` required for Next.js inline styles; remove in Phase 2 if nonce-based CSP is implemented |
| `img-src` | `'self' data: https:` | `data:` for base64 avatars; `https:` for any HTTPS image source |
| `connect-src` | `'self' wss://*.vici2.example.com` | WSS wildcard needed for SIP.js WebSocket to FreeSWITCH per tenant subdomain |
| `media-src` | `'self' blob:` | `blob:` needed for WebRTC media streams (getUserMedia / MediaRecorder) |
| `frame-ancestors` | `'none'` | Prevents all framing (clickjacking) — equivalent to `X-Frame-Options: DENY` |
| `base-uri` | `'self'` | Prevent base tag injection |
| `form-action` | `'self'` | Prevent form hijacking |
| `upgrade-insecure-requests` | (present) | Upgrade any stray HTTP subresource requests to HTTPS |

---

## `unsafe-inline` in style-src — Justification and Roadmap

`unsafe-inline` in `style-src` is a known weakness. It is present because
Next.js 14 (app router) injects inline `<style>` tags for CSS-in-JS and
server components. Without it, styles break.

**Phase 2 roadmap:** Switch to nonce-based CSP using
`headers()` in Next.js `middleware.ts` to inject a per-request nonce into
both the CSP header and inline style tags. This eliminates the need for
`unsafe-inline`. Tracked as a security hardening item.

---

## Complementary Headers

All served alongside CSP by the Caddy `header` directive:

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (belt-and-suspenders alongside `frame-ancestors 'none'`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=(self), payment=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |

`microphone=(self)` is mandatory for the WebRTC agent UI (A02). Removing it
breaks the browser's `getUserMedia()` permission grant.

---

## Testing CSP

**Local test (browser):**
1. Open browser DevTools → Console tab
2. Look for CSP violation reports (red error messages)
3. Common false positives: browser extensions injecting scripts → these are
   not real violations and should be ignored

**CI test (ZAP):**
ZAP baseline checks CSP headers (plugin ID 10038). The `.zap/rules.tsv` file
controls whether violations block PRs.

**Manual check:**
```bash
curl -I https://staging.vici2.example.com | grep -i "content-security-policy"
```

---

## SRI (Subresource Integrity)

Any third-party JS loaded via `<script src="...">` must include an `integrity`
attribute with the SHA-384 hash. Currently no third-party JS is loaded in
the agent UI or admin UI (all is bundled by Next.js).

If third-party scripts are added in future (analytics, support widget), SRI
must be added. This is enforced by the CSP `script-src 'self'` directive —
any non-self script without SRI will be blocked.

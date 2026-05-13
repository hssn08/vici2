# Module A02 — SIP.js Browser Softphone Integration — PLAN

**Module:** A02 (Agent UI track, Phase 1)
**Author:** A02 PLAN sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 48 citations behind every choice.
**Depends on (PLANs already FROZEN):** A01 (web shell + slots + stores),
F03 (`wss` profile :7443, DTLS-SRTP mandatory, OPUS+PCMU codecs, RFC 2833
DTMF), F05 (SIP credential issuance + JWT), T03 RESEARCH (park extension
pattern `*9{tid}_{uid}` joining conference `agent_t<tid>_u<uid>@default`).
**Blocks:** A04 (manual dial — uses `useSoftphone()` for DTMF/hangup),
A05 (live call panel — reads softphone status + stats, calls
mute/hold/etc.), A06 (hotkeys → softphone commands), A07 (transfers —
SIP-side hold + WS-side conference moves), S02 (supervisor whisper
reuses SIP.js).

This document turns the A02 spec + RESEARCH findings into the exact
SIP.js version, file layout, hook surface, connection flow, ICE/audio/
DTMF/reconnect strategy, and hand-off contracts the IMPLEMENT phase will
deliver. **No `.tsx` is produced here**; every file is described in
prose. Once approved, the public surface (hook signature, provider
component, env vars) is FROZEN.

---

## 0. TL;DR (10-bullet decision summary)

1. **SIP.js 0.21.3** pinned **exact** (no caret). Matches ViciDial's
   ViciPhone v3 production usage; latest active tag (Mar 2025); MIT;
   TypeScript-native; zero runtime deps. Renovate PRs gate any bump on a
   full Playwright run.
2. **Code lives at `web/src/lib/sip/`** (the slot reserved by A01 PLAN
   §3.1 + §16). The `SipProvider` mounts inside `(agent)/AgentShell.tsx`;
   `useSoftphone()` is the single public hook consumed by A04/A05/A06/A07.
3. **WSS to FreeSWITCH on `wss://<fs-host>:7443`**, subprotocol `"sip"`
   (RFC 7118; SIP.js `Web.Transport` sets the header automatically).
   DTLS-SRTP mandatory (matches F03 `wss` profile
   `rtp-secure-media=mandatory`). Dev: `mkcert` host CA. Prod: Let's
   Encrypt wildcard. **No plaintext `ws://` in any non-dev path.**
4. **Connection flow on agent login:** (a) F05 `/api/auth/login` returns
   `sip_creds` (in-memory, never localStorage); (b) construct
   `Web.SimpleUser`; (c) `connect()` → WSS established;
   (d) `register()` → REGISTER 200 OK (digest auth);
   (e) `call("sip:" + parkExtFor(tenantId,userId) + "@" + domain)` →
   T03 dialplan extension `*9{tid}_{uid}` answers and joins
   `agent_t<tid>_u<uid>@default`; (f) one nail-up audio leg for the
   shift.
5. **Park extension pattern (FROZEN):**
   `process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN = "*9{tid}_{uid}"`
   (literal placeholders substituted at INVITE time by a
   `parkExtFor(tenantId, userId)` helper from `lib/sip/parkExt.ts`).
   Default pattern matches T03 RESEARCH §3.2 + RFC-002's
   `agent_t<tid>_u<uid>` conference rename. **Single env change unblocks
   any T03 PLAN deviation; no code change required.**
6. **Re-REGISTER** auto-refreshed via SIP.js `Registerer` at 90% of
   `expires` (configured via `RegistererOptions.refreshFrequency: 90`;
   FS default `expires=600 s` → refresh at ~540 s, leaving margin for
   network blips). On refresh failure → `phase='reconnecting'` and the
   transport reconnect loop drives recovery.
7. **Inbound INVITE handling (rare in conference model):**
   `delegate.onCallReceived = () => simpleUser.answer()` auto-answers
   without UI prompt. The agent has consented by logging in and is in
   `ready` state. Used by S02 supervisor whisper, admin pings, and any
   future direct-DID-to-agent route. Manual accept/decline UX is a
   future override on the delegate, not in A02 scope.
8. **Audio device management:** `getUserMedia({audio: {echoCancellation,
   noiseSuppression, autoGainControl, deviceId}})` for mic;
   `HTMLMediaElement.setSinkId(deviceId)` for speaker (feature-detected
   — Safari skipped with disabled-picker + tooltip). Device picker UI
   slot lives in `(agent)/settings/page.tsx` (A01 ships the slot;
   A02 fills it with the picker component imported from `lib/sip/`).
9. **ICE strategy is two-phase**: Phase 1 = STUN-only
   (`stun.l.google.com:19302` + optional self-hosted); Phase 2 =
   self-hosted coturn with ephemeral REST-issued credentials minted by
   F-API HMAC-SHA1 against `--use-auth-secret`. **A02 just consumes
   whatever `iceServers` F05 returns** — coturn deployment owner is a
   separate Phase-2 module (`X06`-ish; not blocking A02).
10. **Hand-offs:** A04 (manual dial — calls
    `useSoftphone().sendDtmf()` for DTMF + relies on customer leg arriving
    in conference, no extra INVITE), A05 (call panel — reads `status` +
    `stats` + drives mute/hold/hangup), A06 (hotkeys → softphone
    commands), A07 (transfers — SIP-side hold + server-side conference
    moves), S02 (supervisor whisper reuses `SimpleUser`),
    F05 (SIP cred issuance + WS token), F03 (WSS profile + codecs +
    DTMF), T03 (park extension + conference name), O01 (softphone
    metrics).

---

## 1. Library version (FROZEN)

### 1.1 Decision

**`sip.js` `0.21.3` — pinned exact** (no `^`, no `~`). Matches RESEARCH
§2.3.

```jsonc
// web/package.json (excerpt)
"dependencies": {
  "sip.js": "0.21.3"
}
```

### 1.2 Why exact pin

- SIP.js patch releases have shipped breaking-flavored changes inside
  `SimpleUser` before (0.21.0 changed `register` signature). Treat
  patches as minor bumps until we have a contract test matrix.
- Renovate PRs with a full Playwright run on a real-WebRTC harness
  must be green before any bump.

### 1.3 Why SIP.js (vs alternatives)

Per RESEARCH §2.2 + §2.3:

- **JsSIP rejected** — JS-only types, no `SimpleUser` facade, slower
  release cadence.
- **sipML5 rejected** — dead since ~2017, security-review liability.
- **`react-sip-phone` rejected** — bundles a UI; conflicts with shadcn
  + our Zustand state model.
- **`webrtc2sip` rejected** — server-side gateway, not a browser
  client.
- **SIP.js wins** on TS-native types, active 2025 maintenance, OnSIP
  stewardship, FreeSWITCH interop documented in their own guide,
  `Web.SimpleUser` facade matches A02.md's pseudocode 1:1, and
  ViciPhone v3 is a real production data-point for SIP.js + call-center
  + FreeSWITCH/Asterisk + browser.

### 1.4 Subdependencies surfaced

`sip.js` ships zero runtime deps. Bundle adds ~270 KB minified
(~85 KB gzipped). Lives in the `(agent)` route chunk only — never
imported by RSC or the `(public)` shell. A01's bundle budget
(≤ 250 KB gzipped per agent route) absorbs this; analyzer report from
A01 IMPLEMENT will confirm.

---

## 2. Code location & file layout (FROZEN)

### 2.1 Directory

`web/src/lib/sip/` — the slot reserved by A01 PLAN §3.1 (file tree),
§5 (`auth.sipCreds` already populated by login), and §16 (hand-off:
"A02 SIP.js — `(agent)/AgentShell.tsx` mounts `<SipProvider/>`;
`SipProvider` is a stub today, A02 fills with SIP.js SimpleUser.
Exposes `useSipPhone()` from `lib/sip/`.").

A01 named the hook `useSipPhone()` in §16; the A02.md spec freezes the
public name as `useSoftphone()`. **Resolution:** the canonical name is
`useSoftphone()`; A01's `lib/sip/index.ts` placeholder will re-export
it. Any A01 doc using `useSipPhone` is a doc-only relabel.

### 2.2 Files A02 IMPLEMENT will create

```
web/src/lib/sip/
├── SipProvider.tsx          ← React context provider; mounts at AgentShell
├── useSoftphone.ts          ← public hook returning state + commands
├── createSimpleUser.ts      ← SIP.js Web.SimpleUser factory + options builder
├── audio.ts                 ← mic/speaker enumerate, deviceId pin, replaceTrack
├── dtmf.ts                  ← RFC 4733 send + SIP-INFO escape hatch
├── stats.ts                 ← RTCStatsReport polling, jitter/loss/RTT/audioLevel
├── reconnect.ts             ← custom exponential backoff + jitter
├── parkExt.ts               ← parkExtFor(tenantId, userId) substitution helper
├── log.ts                   ← SIP.js LogConnector → pino sink (no SDP/passwords)
├── audioElement.tsx         ← hidden <audio id="remoteAudio" autoplay playsinline/>
├── deviceUx/
│   ├── MicPermissionGate.tsx ← detect/prompt + denied-state recovery UI
│   ├── DevicePicker.tsx      ← mic + speaker picker (Safari hides speaker)
│   └── AudioGate.tsx         ← (re-export of A01's AudioGate; A02 wires .play())
├── types.ts                  ← SoftphoneStatus, SoftphoneStats, SoftphoneError
└── index.ts                  ← barrel: SipProvider, useSoftphone, types

web/src/test/sip/
├── createSimpleUser.test.ts  ← option shape, env substitution
├── parkExt.test.ts           ← {tid}/{uid} substitution rules
├── reconnect.test.ts         ← backoff schedule with fake timers
├── dtmf.test.ts              ← RFC 4733 vs SIP-INFO mode toggle
├── stats.test.ts             ← getStats parser → jitter/loss/RTT
├── audio.test.ts             ← enumerateDevices fanout, replaceTrack
└── e2e/
    └── softphone.spec.ts     ← Playwright + mock SIP server (SIPp scenario)
```

### 2.3 Files A02 IMPLEMENT will modify (light touches)

| File | Change |
|---|---|
| `web/src/components/providers/SipProvider.tsx` (A01 stub) | Replace stub re-export with import from `@/lib/sip` |
| `web/src/app/(agent)/AgentShell.tsx` | Mount `<SipProvider><AudioElement/>{children}</SipProvider>` |
| `web/src/app/(agent)/settings/page.tsx` | Render `<DevicePicker/>` from `@/lib/sip/deviceUx` |
| `web/src/lib/stores/auth.ts` | (no change) — `sipCreds` already in shape |
| `web/src/lib/stores/call.ts` | Add `phase: 'reconnecting'` to existing union (A01's union already includes the value per A01 PLAN §5.1; verify in IMPLEMENT) |
| `web/src/lib/stores/ui.ts` | Add `dtmfMode: 'rfc2833' \| 'sip-info'`, `forceTurn: boolean`, `preferredMicId?`, `preferredSpeakerId?` to the `ui` slice (persisted) |
| `web/.env.example` (via root `.env.example`) | Add `NEXT_PUBLIC_AGENT_PARK_PATTERN`, `NEXT_PUBLIC_FS_WSS` (A01 already declares the latter) |

### 2.4 No file outside `web/` is touched by A02

The TURN-credential minting endpoint (Phase 2) is owned by F05 (or a
new Phase-2 module). The FS XML directory is owned by F05. The dialer
is unrelated. **A02 is browser-only.**

---

## 3. Connection flow (FROZEN)

### 3.1 Sequence on agent login

```
1. User submits login form (A01 LoginForm.tsx).
2. F05 /api/auth/login returns:
     {
       access_token, ws_token, user,
       sip_creds: {
         ws_uri:      "wss://fs.vici2.example:7443",
         domain:      "vici2.local",
         auth_user:   "<userId>",
         password:    "<cleartext from F05 envelope decrypt>",
         ice_servers: [
           { urls: ["stun:stun.l.google.com:19302"] },
           { urls: ["stun:stun.vici2.example:3478"] }
           // Phase 2: TURN entries with ephemeral creds appended here
         ]
       }
     }
3. A01 useAuthStore.setSession(...) puts sip_creds in memory ONLY
   (never localStorage, never cookie, never logged).
4. A01 routes to /dashboard under (agent) group; AgentShell mounts.
5. AgentShell mounts <SipProvider/>.
6. SipProvider useEffect on useAuthStore.sipCreds → fires once when truthy:
     a. Acquire mic via navigator.mediaDevices.getUserMedia({audio: …})
        in the same task that handled the login-button click
        (user-gesture context → satisfies autoplay policy).
        Cache the MediaStream so SIP.js's later getUserMedia returns it.
     b. const su = createSimpleUser(sipCreds, { onEvent: dispatcher }).
     c. await su.connect()           // WSS+TLS up; no SIP yet.
     d. await su.register()          // 401-digest-200 dance.
     e. const target = "sip:" + parkExtFor(user.tenantId, user.id) +
                       "@" + sipCreds.domain;
        await su.call(target);       // INVITE; T03 dialplan answers,
                                     // joins agent_t<tid>_u<uid>@default.
     f. setStatus('registered'); ...→'on-call' once SDP completes.
7. On tab restore (no in-memory session), A01 fetches GET /api/auth/me
   ?include=sip_creds → sip_creds repopulated → SipProvider boots same.
```

### 3.2 SimpleUser construction (sketch — actual code in IMPLEMENT)

```ts
// web/src/lib/sip/createSimpleUser.ts
import { Web } from "sip.js";
import { parkExtFor } from "./parkExt";

export function createSimpleUser(
  sipCreds: SipCreds,
  user: { id: number; tenantId: number },
  remoteAudioEl: HTMLAudioElement,
  prefs: { micDeviceId?: string; iceTransportPolicy: "all" | "relay" },
): Web.SimpleUser {
  const aor = `sip:${user.id}@${sipCreds.domain}`;
  const options: Web.SimpleUserOptions = {
    aor,
    userAgentOptions: {
      authorizationUsername: String(user.id),
      authorizationPassword: sipCreds.password,
      transportOptions: {
        server: sipCreds.wsUri,           // wss://fs.vici2.example:7443
        // SIP.js Web.Transport sets the "sip" subprotocol itself
      },
      sessionDescriptionHandlerFactoryOptions: {
        iceServers: sipCreds.iceServers,
        peerConnectionConfiguration: {
          iceTransportPolicy: prefs.iceTransportPolicy,    // "all" default
          bundlePolicy: "max-bundle",
          rtcpMuxPolicy: "require",
        },
      },
      logLevel: "warn",
      logBuiltinEnabled: false,           // we pipe through log.ts
      logConnector: pinoLogConnector,
    },
    media: {
      constraints: {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: { ideal: 48000 },
          deviceId: prefs.micDeviceId
            ? { exact: prefs.micDeviceId }
            : undefined,
        },
        video: false,
      },
      remote: { audio: remoteAudioEl },
    },
    // Custom backoff lives in reconnect.ts; these are SIP.js-internal:
    reconnectionAttempts: Infinity,
    reconnectionDelay: 4,
    delegate: {
      onCallReceived: async () => { await simpleUserRef.current?.answer(); },
      onCallHangup:   () => { dispatchHangup(); },
    },
    registererOptions: {
      refreshFrequency: 90,                // refresh at 90% of expires
    },
  };
  return new Web.SimpleUser(sipCreds.wsUri, options);
}
```

### 3.3 `parkExtFor` helper (FROZEN signature)

```ts
// web/src/lib/sip/parkExt.ts
/**
 * Substitute {tid} and {uid} in NEXT_PUBLIC_AGENT_PARK_PATTERN.
 * Default pattern: "*9{tid}_{uid}".
 *
 * Examples:
 *   parkExtFor(1, 1042) === "*91_1042"
 *
 * If T03 PLAN deviates (e.g. picks "agent_park_t{tid}_u{uid}"), the
 * env var alone is changed; no code change required.
 */
export function parkExtFor(tenantId: number, userId: number): string {
  const tmpl =
    process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN ?? "*9{tid}_{uid}";
  return tmpl.replace("{tid}", String(tenantId))
             .replace("{uid}", String(userId));
}
```

### 3.4 Self-signed cert pitfall (dev)

The most common dev failure is silent TLS reject when the browser
doesn't trust the FS cert. F01 PLAN provides `mkcert` for dev so this
is sidestepped automatically. A02 IMPLEMENT documents the symptom and
the manual workaround (visit `https://<fs-host>:7443/` to accept cert
exception, then reload) in HANDOFF for prod ops who skip LE setup.

---

## 4. WSS handshake (FROZEN)

### 4.1 Subprotocol

Literal `"sip"` per RFC 7118 §3.4. SIP.js `Web.Transport` sets the
`Sec-WebSocket-Protocol: sip` header automatically. A02 code does NOT
override this and does NOT confuse it with the F-API control-socket
auth (A01 PLAN §6.2 uses `?token=` for F-API; the FreeSWITCH SIP socket
is an entirely separate connection with `subprotocol="sip"`).

### 4.2 URL form

```
wss://<fs-host>:7443
```

Source: F03 PLAN §1.1 (`wss-binding=:7443`). F03 PLAN's parallel
plaintext `ws://` on 5066 is dev-only (`WSS_ENABLE_PLAINTEXT_WS=true`),
**not** wired into A02 by default; an env override
`NEXT_PUBLIC_FS_WSS=ws://localhost:5066` exists for cert
troubleshooting.

### 4.3 DTLS-SRTP

Mandatory per F03 PLAN's wss profile (`rtp-secure-media=mandatory`,
`rtp-secure-media-inbound=mandatory`,
`rtp-secure-media-outbound=mandatory`). Browsers always do DTLS-SRTP,
so this is free. The TLS cert at FS is the same one terminating WSS
(F03 PLAN §1.6 single combined PEM at `/etc/freeswitch/tls/wss.pem`);
the DTLS fingerprint is derived from it.

### 4.4 Cert sourcing

| Env | Source |
|---|---|
| Dev | `mkcert -install` on the host, host CA trusted by Chrome/Firefox; FS uses the resulting cert |
| Prod | Let's Encrypt wildcard via DNS-01 (UDP-friendly), staged into the FS PEM |

A02 does not own cert lifecycle — F03 / O05 do. A02 only depends on
the URL host matching the cert SAN (a HANDOFF note repeats this for
ops).

---

## 5. Codec & DTMF wire format (FROZEN, derived from F03)

| Concern | Value | Source |
|---|---|---|
| Browser-preferred codec | OPUS | F03 PLAN §9 (`wss_codec_prefs="OPUS,PCMU"`) |
| Browser fallback codec | PCMU (G.711 µ-law) | F03 PLAN §9 |
| RTCP-MUX | Required | RFC + F03 dialplan template |
| DTMF wire format | RFC 4733 / RFC 2833 | F03 PLAN `dtmf-type=rfc2833`, `rfc2833-pt=101` |

A02 sets `bundlePolicy: "max-bundle"` + `rtcpMuxPolicy: "require"`
in `peerConnectionConfiguration` so SDP negotiation stays compatible
with FS's defaults.

---

## 6. Re-REGISTER & cred rotation

### 6.1 Re-REGISTER (automatic)

- Default `expires=600 s` (FS default; SIP.js `Registerer` honors what
  the server returns).
- `RegistererOptions.refreshFrequency: 90` → SIP.js refreshes at 90%
  of `expires` (~540 s), leaving ~60 s margin for a network blip.
- On 401 mid-refresh (cred rotated server-side), SIP.js fires
  `onTransportError`. We surface `phase='reconnecting'` and let the
  reconnect loop re-evaluate creds (see §10).

### 6.2 Cred rotation (out of scope, design hook only)

- F05 ships `POST /api/auth/sip/rotate` (per F05 PLAN §14.1).
- After rotation, F05 returns new sip_creds in the next refresh
  response. A02 IMPLEMENT subscribes to `useAuthStore.sipCreds`
  changes; if `sipCreds.password !== lastSeenPassword`, A02 calls
  `simpleUser.unregister()` → reconfigure → `register()`.
- Phase 1 punt: rotation forces a normal logout-then-relogin cycle
  (the in-memory password is invalidated; A01's logout cascade
  triggers).
- Hot-rotate hook documented for Phase 2 in HANDOFF.

---

## 7. Inbound INVITE handling (FROZEN)

### 7.1 Auto-answer

`delegate.onCallReceived = async () => { await simpleUser.answer(); }`

The SIP.js FreeSWITCH guide explicitly recommends this pattern. Agent
has consented by logging in and is in `ready`; a manual prompt would
add friction and hurt response latency.

### 7.2 When this fires (rare in conference model)

The conference primitive (DESIGN.md §4.4, T03/T04) means customer
audio appears in the existing conference, NOT as new INVITEs to the
browser. The inbound delegate fires only for:

- **S02 supervisor whisper** — supervisor sends fresh INVITE to inject
  whisper audio.
- **Admin pings** — connectivity test calls.
- **Future direct-DID-to-agent** routes (post-Phase-1).

For all of these, auto-answer is correct.

### 7.3 Ringback suppression

A02 does not play a ringback tone. The agent doesn't need one (call
state is reflected in `useCallStore.phase`); supervisor whisper is a
silent injection. If a future module needs ringback, it overrides
`delegate.onCallReceived` to delay the auto-answer and play a tone.

---

## 8. Audio device management (FROZEN)

### 8.1 Microphone

- Acquire via `getUserMedia({audio: {echoCancellation, noiseSuppression,
  autoGainControl, deviceId, channelCount: 1, sampleRate: {ideal:
  48000}}})`.
- `deviceId` sourced from `useUiStore.preferredMicId` (A01 ui slice
  extended in §2.3).
- Switch mid-call via `RTCRtpSender.replaceTrack(newTrack)` (no SDP
  renegotiate). Fallback (re-INVITE) only if `replaceTrack` rejects.
- Permission requested **immediately after login**, in
  `AgentShell` mount effect, so the prompt isn't surprising
  mid-call. The granted MediaStream is cached for SIP.js's later
  `getUserMedia` call.

### 8.2 Speaker

- `HTMLMediaElement.setSinkId(deviceId)` on the hidden `<audio
  id="remoteAudio">` element.
- Feature-detection: `'setSinkId' in audioEl`. **Safari skipped**:
  `<DevicePicker/>` shows the speaker dropdown but disabled with a
  tooltip "Use System Preferences → Sound on Safari" (per RESEARCH
  §6.2).
- Persisted in `useUiStore.preferredSpeakerId`; re-applied on mount.

### 8.3 Volume

- HTML5 `<audio>.volume` (0..1) bound to `useUiStore.volume`. No Web
  Audio graph in Phase 1.

### 8.4 Permission UX

- `navigator.permissions.query({name:'microphone'})` → `'denied'`
  triggers full-screen `<MicPermissionGate/>` modal with browser-
  specific instructions + "Try again" button that re-calls
  `getUserMedia()`.
- `navigator.mediaDevices.ondevicechange` listener refreshes the
  device picker.
- A01's `<AudioGate/>` overlay handles the `audio.play()` rejection
  case (Safari strict autoplay).

---

## 9. ICE strategy (FROZEN)

### 9.1 Phase 1 — STUN-only

A02 consumes whatever F05 returns. Recommended Phase-1 default:

```jsonc
[
  { "urls": ["stun:stun.l.google.com:19302"] },
  { "urls": ["stun:stun.vici2.example:3478"] }    // optional self-host
]
```

Sufficient for MVP demo (agents on same LAN/VPC as FS). `stun.l.google.com`
acceptable for Phase 1; replace before customer GA.

### 9.2 Phase 2 — TURN via self-hosted coturn

When restrictive corporate-NAT agents need it, F05 appends TURN
entries to `iceServers`:

```jsonc
{
  "urls": [
    "turn:turn.vici2.example:3478?transport=udp",
    "turn:turn.vici2.example:3478?transport=tcp",
    "turns:turn.vici2.example:5349?transport=tcp"
  ],
  "username":   "<F-API-minted ephemeral, ~1h TTL>",
  "credential": "<HMAC-SHA1(secret, username) base64>"
}
```

Coturn deployment: `instrumentisto/coturn` Alpine image,
`network_mode: host`, `--use-auth-secret --static-auth-secret=$SECRET`,
draft-uberti-behave-turn-rest credential format.
**Owner:** new Phase-2 module (capture as `X06`-ish; not blocking A02).

### 9.3 ICE policy notes

- `iceTransportPolicy: "all"` default (host + srflx + relay).
- `useUiStore.forceTurn = true` → flips to `"relay"` for support
  ("does forcing TURN fix your audio?" diagnostic).
- `bundlePolicy: "max-bundle"`, `rtcpMuxPolicy: "require"`.
- Half-trickle ICE for Phase 1 (SIP.js default). Revisit if post-dial
  delay > 2 s.

### 9.4 ICE servers shape (FROZEN with F05)

`sip_creds.ice_servers` is an array of `RTCIceServer`-shaped objects:

```ts
type IceServer = {
  urls: string[];           // never single string; always array
  username?: string;
  credential?: string;
};
```

A01 PLAN's `useAuthStore.sipCreds.iceServers` is typed as `RTCIceServer[]`
already (matches `lib.dom.d.ts`).

---

## 10. Reconnect handling (FROZEN)

### 10.1 Layers

Three things can drop:

1. **WebSocket** (TCP) — wifi blip, network change.
2. **REGISTER expiry** — handled by `Registerer` auto-refresh.
3. **Media (DTLS-SRTP)** — usually survives a brief WS drop; long
   drops trigger ICE-restart; failure → SIP.js tears down session,
   we re-INVITE.

### 10.2 SIP.js-internal config

```ts
reconnectionAttempts: Infinity,   // never give up while tab is open
reconnectionDelay: 4,             // base seconds
```

### 10.3 Custom backoff (`reconnect.ts`)

Wraps SIP.js's fixed delay with our own exponential ladder:

```
attempt: 1   2   3   4   5   6+
delay s: 0   1   2   4   8   30
```

with ±25% jitter; ceiling 30 s. Surfaced via `useCallStore.phase =
'reconnecting'`.

Custom listener on `window.addEventListener('online', ...)` calls
`simpleUser.reconnect()` to collapse latency on wake-from-sleep.

### 10.4 Reconcile state on reconnect

After WSS comes back:

1. Re-REGISTER (Registerer does this automatically).
2. Verify the agent's conference leg is still alive: read
   `simpleUser.session?.state`. If `Terminated` (FS dropped because we
   were gone too long), re-INVITE
   `sip:${parkExtFor(tid,uid)}@${domain}`.
3. (A03 module's WS replay is separate; A02 doesn't manage it.)
4. Emit `vici2_softphone_recovered_total`.

### 10.5 Hard-failure UX

| Time gone | UI |
|---|---|
| 0–30 s | Silent reconnect; toast `"Reconnecting…"` only after 5 s |
| 30 s–1 min | Banner "Audio reconnecting — please check your network" |
| > 5 min, still online | Banner suggests "Try logging out and back in" |

**Never auto-logout** — the agent might have a customer in the
conference (FS keeps the customer leg even when our SIP signaling
drops). The agent can manually re-engage.

---

## 11. Multi-call handling (simplified by conference)

### 11.1 One SIP session for the whole shift

The conference primitive means SIP.js sees exactly **one** session: the
park leg into `agent_t<tid>_u<uid>`. All transfers / 3-way / customer
audio routing happen as conference operations server-side
(T03/T04/A07). The browser is purely a media endpoint.

Therefore A02 ships with `Web.SimpleUser` (single-session API) for
the entire MVP. No `UserAgent` + multi-`Inviter` complexity.

### 11.2 Hold (the one session)

- `simpleUser.hold()` sends re-INVITE with `a=sendonly`;
  `simpleUser.unhold()` sends `a=sendrecv`.
- FS conference profile (T03/F03) plays MoH (`hold-music=local_stream://moh`)
  to the customer while the agent is on hold.
- A 5-s timeout on the hold promise reverts UI state on rejection
  (defensive, per RESEARCH §8.3).

### 11.3 Mute (local mic, NOT a SIP op)

- `localAudioTrack.enabled = false` toggles silence to far side.
- No re-INVITE, no SIP traffic.
- Reflected in `useCallStore.muted`.

### 11.4 Future second-leg path (deferred)

If a future module ever needs a true second SIP call (e.g., S02
supervisor barge), it drops down to `simpleUser.userAgent` +
`new Inviter(...)` with one `<audio>` per session. **A02 does not
ship this code path.** Documented in HANDOFF as a known extension
point.

---

## 12. DTMF (FROZEN)

### 12.1 Primary: RFC 4733 telephone-event

- `simpleUser.sendDTMF(tone)` → `Web.SessionDescriptionHandler.sendDtmf()`
  → `RTCDTMFSender` over the negotiated `telephone-event` payload
  (`a=rtpmap:101 telephone-event/8000`, matches F03's `rfc2833-pt=101`).
- This is the default for all agents.

### 12.2 Escape hatch: SIP INFO

- For IVRs that don't decode RFC 4733 reliably, `useUiStore.dtmfMode =
  'sip-info'` flips to:
  ```ts
  session.info({
    requestOptions: {
      body: {
        contentDisposition: "render",
        contentType: "application/dtmf-relay",
        content: `Signal=${tone}\r\nDuration=100`,
      },
    },
  });
  ```
- Toggle exposed in `(agent)/settings/page.tsx` under "Advanced".

### 12.3 Inbound DTMF

Not handled in Phase 1 (IVR sits at FS level, never the browser). If a
future module needs it, it registers `delegate.onCallDTMFReceived` and
ensures FS sends INFO instead of inband (per RESEARCH §9.4 — RFC 4733
inband does NOT trigger SIP.js's `onCallDTMFReceived`).

---

## 13. Logging & telemetry

### 13.1 SIP.js LogConnector → pino

- Default level `warn` in prod, `debug` in dev.
- Forwarded to F-API via A01's `/api/metrics/web` sink for
  `warn`/`error` frames (rate-limited to 1/sec per type).
- **Never logged:**
  - `authorizationPassword` (per SPEC §3.4).
  - SDP body (leaks ICE candidates with internal IPs).
  - Media stream contents (impossible by design; reiterated in code
    comment).

### 13.2 Metrics emitted (via web vitals → /api/metrics/web → F-API → Prom)

| Metric | Type | Notes |
|---|---|---|
| `vici2_softphone_register_duration_seconds` | histogram | login click → REGISTER 200 OK |
| `vici2_softphone_call_setup_duration_seconds` | histogram | REGISTER → first audio packet |
| `vici2_softphone_recovered_total` | counter | per SPEC §4.7 |
| `vici2_softphone_audio_jitter_ms` | gauge | from `getStats` poll |
| `vici2_softphone_audio_packet_loss_ratio` | gauge | from `getStats` poll |
| `vici2_softphone_register_total{outcome}` | counter | success/failure/locked |
| `vici2_softphone_reconnect_total` | counter | every reconnect cycle |

### 13.3 Audit-log integration

Per F05 RESEARCH §1.10, every privileged auth event is audited.
**Decision (resolved open question):** SIP REGISTER outcomes are audit
events. A02 IMPLEMENT calls `POST /api/audit/softphone` (F05 owns the
endpoint; F05 PLAN §9.2 already lists `auth.sip.rotated` and similar)
on:

- First successful REGISTER per session → `softphone.register.ok`
- Sustained REGISTER failure (>3 consecutive) → `softphone.register.fail`
  (rate-limited to ≤ 1 per 5 minutes per agent so a flapping connection
  doesn't flood the audit log)

A02 does NOT log every WS reconnect; that's metrics, not audit.

---

## 14. Quality monitoring (`stats.ts`, FROZEN)

### 14.1 Polling cadence

`peerConnection.getStats()` every **5 s** by default
(`useUiStore.statsInterval` overridable, range 1000–30000 ms).

**Decision (resolved open question):** 5 s is the literature default
and well within INP budget on a low-end Chromebook (the call costs
~2 ms with no allocations). Lighthouse-CI in A01 catches any
regression.

### 14.2 Extracted metrics

| `report.type` | Field | Threshold (warn / alert) |
|---|---|---|
| `inbound-rtp` (kind=audio) | `jitter` (s) | > 0.030 / > 0.050 |
| `inbound-rtp` | `packetsLost / packetsReceived` (delta) | > 2% / > 5% |
| `remote-inbound-rtp` | `roundTripTime` (s) | > 0.250 / > 0.500 |
| `candidate-pair` (selected) | `currentRoundTripTime` (s) | confirm RTT |
| `inbound-rtp` | `audioLevel` | dead-mic detection (≈ 0 for > 5 s while phase=='active') |

Surfaced via `useSoftphone().stats` for any consumer to render (A05
will display a `<CallQualityPill/>` green/amber/red).

---

## 15. Hooks API (FROZEN)

### 15.1 Public surface

```ts
// web/src/lib/sip/useSoftphone.ts (FROZEN signature)

export type SoftphoneStatus =
  | 'idle'             // no creds yet
  | 'connecting'       // WSS opening or REGISTER in flight
  | 'registered'       // REGISTER 200 OK, no INVITE yet
  | 'on-call'          // park leg active
  | 'on-hold'          // re-INVITE sendonly succeeded
  | 'reconnecting'     // WSS / REGISTER recovery in progress
  | 'error';           // unrecoverable; see error field

export interface SoftphoneError {
  code:
    | 'MIC_PERMISSION_DENIED'
    | 'WSS_TLS_FAIL'
    | 'REGISTER_FAIL'
    | 'INVITE_FAIL'
    | 'TRANSPORT_LOST'
    | 'UNKNOWN';
  message: string;
  cause?: unknown;
}

export interface SoftphoneStats {
  jitterMs: number;
  packetLossPct: number;
  rttMs: number;
  audioLevel: number;       // 0..1
}

export function useSoftphone(): {
  // state
  status: SoftphoneStatus;
  registered: boolean;          // === status in {'registered','on-call','on-hold'}
  error: SoftphoneError | null;
  muted: boolean;
  onHold: boolean;
  micPermission: 'unknown' | 'granted' | 'denied' | 'prompt';
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];

  // controls
  mute(): void;                                // local track.enabled=false
  unmute(): void;
  hold(): Promise<void>;                       // re-INVITE sendonly
  unhold(): Promise<void>;                     // re-INVITE sendrecv
  sendDtmf(digits: string): void;              // RFC 4733 (or SIP-INFO per ui.dtmfMode)
  hangup(): Promise<void>;                     // BYE the customer leg (NOT the park leg)
  selectMic(deviceId: string): Promise<void>;  // replaceTrack
  selectSpeaker(deviceId: string): Promise<void>; // setSinkId; no-op + warn on Safari
  setVolume(level: number): void;              // 0..1
  retryConnect(): void;                        // user-triggered reconnect

  // diagnostics
  stats: SoftphoneStats | null;
};
```

### 15.2 Provider surface

```ts
// web/src/lib/sip/SipProvider.tsx (FROZEN signature)

export function SipProvider({ children }: { children: React.ReactNode }):
  React.ReactElement;

// Behavior:
// - Mounts inside (agent)/AgentShell.tsx.
// - useEffect on useAuthStore.sipCreds:
//     - if truthy: getUserMedia → createSimpleUser → connect/register/call(parkExt)
//     - if becomes null (logout): bye→bye→unregister→disconnect cascade with 3 s deadline
// - Renders <AudioElement/> (hidden <audio id="remoteAudio" autoplay playsinline/>).
// - Exposes context value consumed by useSoftphone().
// - Subscribes to useAuthStore.accessToken (cred rotation) and triggers re-register.
// - On unmount: full teardown (bye→unregister→disconnect→stop tracks).
```

### 15.3 Logout cascade (resolved open question)

**Decision:** when `useAuthStore.clearSession()` fires (logout), the
SipProvider runs in this order with `await` on each, total deadline
3 s, then force-`disconnect()`:

1. `bye()` the customer leg if any (`session.bye()` with cause).
2. `bye()` the park leg.
3. `unregister()`.
4. `disconnect()` the WSS.

Force-disconnect path triggers no UI update beyond what the cascade
already did.

---

## 16. Browser support floor (FROZEN)

| Browser | Status | Notes |
|---|---|---|
| Chrome 120+ | Supported | reference impl |
| Edge 120+ | Supported | Chromium engine, identical |
| Firefox 120+ | Supported | `setSinkId` works in 140+; older versions feature-detected to disable speaker picker |
| Safari 17+ | Supported | No `setSinkId`; speaker picker disabled with tooltip; `playsinline` on audio element; `audio.play()` chained off login click |
| iOS Safari 17+ | Supported (Phase 1 not formally targeted) | extra autoplay strictness |
| Mobile Chrome | Supported (Phase 1 not formally targeted) | |
| IE / Legacy Edge | Not supported | no RTCPeerConnection |

Matches A02.md acceptance criterion verbatim. Older floors mentioned
in some user-task briefs (Chrome 88+ etc.) predate `setSinkId` and
modern permissions UX — A02 sticks to the A02.md higher floor.

---

## 17. Auto-play handling (FROZEN)

- Audio capture (`getUserMedia`) is initiated synchronously off the
  login button click → user-gesture context → satisfies all browser
  autoplay policies.
- Hidden `<audio id="remoteAudio" autoplay playsinline>` element
  attached to `SipProvider` — the autoplay attribute is sufficient on
  Chrome/Firefox; Safari may still reject `play()`.
- A01's `<AudioGate/>` overlay (per A01 PLAN §13) catches the rejected
  case: if the `play()` promise rejects, the gate renders "Click to
  enable audio" and re-tries on click.
- A02 wires this: `audioRef.current.play().catch(() =>
  showAudioGate())`.

---

## 18. Integration with Zustand stores (FROZEN)

### 18.1 Reads from

- `useAuthStore.sipCreds` — drives `SipProvider` boot.
- `useAuthStore.user` — `tenantId` + `id` for `parkExtFor`.
- `useUiStore.preferredMicId`, `preferredSpeakerId`, `volume`,
  `dtmfMode`, `forceTurn`, `statsInterval` — runtime prefs.
- `useCallStore.phase` — checks current phase before issuing
  hold/unhold to avoid no-ops.

### 18.2 Writes to

- `useCallStore` — phase transitions on `register`,
  `onCallReceived`, `onCallHangup`, hold/unhold, mute toggles.
- `useCallStore.muted` — mirrored from local `track.enabled`.
- (`useCallStore.callUuid` is set by A03 from WS events, NOT by A02
  — SIP.js doesn't know the FS UUID until the WS event arrives. A02
  reflects only `phase`, `muted`, `recording` stays unchanged.)

### 18.3 `subscribeWithSelector` boundary

A02 does NOT instantiate stores. It uses the existing A01 stores
through the existing `subscribeWithSelector` pattern. Fine-grained:
A02 subscribes to the **single** field `auth.sipCreds` via selector,
so token-only changes don't re-fire the SIP boot effect.

---

## 19. Testing (FROZEN)

### 19.1 Unit (Vitest, mock SIP.js)

| File | Coverage focus |
|---|---|
| `parkExt.test.ts` | `{tid}/{uid}` substitution; default pattern; env-override pattern; missing placeholders |
| `createSimpleUser.test.ts` | options shape; iceServers wired; codec config; logBuiltinEnabled false |
| `dtmf.test.ts` | RFC 4733 path; SIP-INFO body builder; mode toggle |
| `stats.test.ts` | RTCStatsReport parser → SoftphoneStats; threshold flags |
| `reconnect.test.ts` | backoff schedule with fake timers; jitter range; cap at 30 s |
| `audio.test.ts` | enumerateDevices fanout; replaceTrack call; setSinkId feature detect |
| `useSoftphone.test.ts` | hook contract; status transitions; mute/hold local state |

Coverage target: **≥ 70%** on `web/src/lib/sip/**` (matches SPEC §3.10).

### 19.2 E2E (Playwright + WebRTC mocking)

`test/e2e/softphone.spec.ts` scenarios (A02 ships at minimum 1, 4, 7):

| # | Scenario |
|---|---|
| 1 | Login → mic prompt mock-grant → status=registered → inbound INVITE auto-answers (mock SIP server) |
| 4 | DTMF sequence sent to mock — verify RFC 4733 negotiation in SDP |
| 7 | Drop WS for 5 s → reconnect → status returns to `registered` |

Full table (14 scenarios) in RESEARCH §16; remaining 11 deferred to
A02 VERIFY phase.

### 19.3 Manual smoke (VERIFY phase)

Test against staging FreeSWITCH. Specifically:

- Login on Chrome / Edge / Firefox / Safari → `fs_cli> conference list`
  shows agent in `agent_t<tid>_u<uid>`.
- Originate test customer leg via T04 stub → audio bridges into
  conference.
- Hold → MoH heard remote-side; unhold → audio resumes.
- DTMF `1234` → FS dialplan logs receive correct digits.
- Network blip (toggle wifi 5 s) → audio resumes within 5 s.

### 19.4 Lighthouse a11y

A11y score ≥ 90 on the agent dashboard with `<DevicePicker/>` and
`<MicPermissionGate/>` rendered (per A02.md acceptance + A01 LHCI
gate).

---

## 20. Hand-off interface

### 20.1 To A04 (manual dial)

A04 calls `useSoftphone().sendDtmf(digits)` for any in-band tone
generation. A04 does NOT issue a new INVITE — manual dial creates a
customer leg server-side via `POST /api/agent/originate` (F-API), which
the dialer/T04 transfers into the agent's conference. The browser SIP
session stays the park leg.

### 20.2 To A05 (live call panel)

A05 reads `useSoftphone().status / stats / muted / onHold` and calls
`mute / unmute / hold / unhold / hangup`. `hangup()` BYEs the customer
leg only — the park leg stays alive for the next call.

### 20.3 To A06 (hotkeys)

A06's `KeyboardListenerProvider` (A01 stub) registers handlers that
invoke softphone commands directly (e.g., `Ctrl+M` → `mute()`).

### 20.4 To A07 (transfers)

A07 issues SIP-side `hold()` for warm transfer, then sends a WS
command (`{op:'transfer', target}`) for the server-side conference
move. A07 does NOT issue REFER from the browser (the conference model
makes REFER unnecessary).

### 20.5 To S02 (supervisor whisper, Phase 3)

S02 reuses the same `SipProvider` + `useSoftphone()` for the
supervisor's own SIP leg. The whisper-into-agent-conference path is a
supervisor-side INVITE that hits the agent's auto-answer delegate.

### 20.6 To F05

A02 consumes `sip_creds` from `/api/auth/login` and `/api/auth/me`
responses. A02 calls `POST /api/audit/softphone` for register events
(see §13.3). F05 PLAN §15.2 already lists the cred shape; A02
formalizes the `iceServers` field as `RTCIceServer[]` (urls always
array).

### 20.7 To F03

A02 connects to `wss://<fs-host>:7443` per F03 PLAN §1.1. Codec
prefs OPUS,PCMU + RFC 2833 DTMF (PT 101) + DTLS-SRTP mandatory all
match F03 PLAN §9 + §1.6.

### 20.8 To T03

A02 uses `parkExtFor(tenantId, userId)` which substitutes
`NEXT_PUBLIC_AGENT_PARK_PATTERN` (default `*9{tid}_{uid}`). The
INVITE target lands in T03's dialplan extension which auto-joins
`agent_t<tid>_u<uid>@default`. Single env change unblocks any T03
PLAN deviation.

### 20.9 To O01

A02 emits the metrics in §13.2. O01 builds dashboards/alerts on
`vici2_softphone_*` series.

---

## 21. Resolved open questions (from RESEARCH §18)

1. **T03 dial pattern** → `*9{tid}_{uid}` per RFC-002, env-overridable
   via `NEXT_PUBLIC_AGENT_PARK_PATTERN`.
2. **F05 `iceServers` field shape** → `{ urls: string[], username?,
   credential? }[]` (matches `RTCIceServer`); confirmed in §9.4.
3. **Coturn deployment owner** → Phase-2 separate module; A02 only
   consumes whatever F05 returns.
4. **getStats cadence vs INP budget** → 5 s default, configurable
   via `useUiStore.statsInterval` (1000–30000 ms range).
5. **Audit-log integration for register events** → yes, via
   `POST /api/audit/softphone` (rate-limited; see §13.3).
6. **Logout vs unregister vs hangup ordering** → bye(customer) →
   bye(park) → unregister → disconnect, with 3 s deadline then force
   disconnect (§15.3).
7. **Pre-recorded test audio for VERIFY** → owned by O03 (load-test
   harness); A02 VERIFY notes the dependency.
8. **Mac dev WebRTC quirks** → documented in HANDOFF: "use Chrome
   inside the Linux dev VM, not Safari on the host."
9. **Audio-output picker on Safari** → show disabled with tooltip
   (per RESEARCH §6.2), so users see we know about the gap.
10. **WS-vs-WSS for F-API control socket vs SIP socket** → two
    separate sockets, two separate URLs, two separate auth schemes.
    HANDOFF spells out: F-API control socket = `wss://api/...?token=`
    (A01 PLAN §6.2); SIP socket = `wss://fs:7443` with subprotocol
    `sip` (A02 §4). Future maintainer must not merge them.

---

## 22. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Browser microphone permission denied** | High | High | Clear `<MicPermissionGate/>` UI with browser-specific instructions + "Try again" + retry path. |
| **WSS cert untrusted in dev** | High | Med | `mkcert` documented in F01 HANDOFF; A02 HANDOFF repeats the symptom + manual workaround for prod ops. |
| **Conference name mismatch (T03 deviates)** | Low | High | `parkExtFor` helper centralizes the only place names are constructed; env-overridable; one-line fix if T03 PLAN renames. |
| **Safari `audio.play()` rejection** | Med | Low | A01's `<AudioGate/>` catches it; A02 wires `play().catch(showAudioGate)`. |
| **Browser kills `getUserMedia` mid-shift** (devicechange or kernel reset) | Med | Med | `ondevicechange` listener + retry path; if irrecoverable → `phase='error'` + UI prompt to logout/relogin. |
| **SIP.js API churn on patch bump** | Low | Med | Exact pin; Renovate PRs gated on Playwright run. |
| **Cleartext SIP password in memory** | Inherent | Low | F05 RESEARCH §1.7 flags Phase-2 hardening (xml_curl loopback) so cleartext never touches the browser. A02 acknowledges and relies on F05's Phase-2 work. |
| **Conference auto-creation race on first login of the day** | Low | Low | T03 / F03 dialplan auto-creates conference on first INVITE; A02 just retries the INVITE once on 503. |
| **TURN ephemeral cred expiry mid-call** | Med | Low | Phase 2 concern; F05 mints with sufficient TTL (~1h); A02 accepts new creds on next refresh-token roll. |
| **Mac dev quirks** | High on Mac | Low | "Use Chrome in Linux VM" documented; A02 IMPLEMENT can be done on Linux exclusively. |

---

## 23. Acceptance criteria (restated from A02.md, expanded)

- [ ] Auto-join conference on login (INVITE to `parkExtFor(tid,uid)`).
- [ ] Auto-answer inbound INVITEs via `delegate.onCallReceived`.
- [ ] `mute / unmute / hold / unhold / sendDtmf / hangup` primitives
      work and round-trip through SIP/RTP.
- [ ] Mic-denied UX clear and recoverable via `<MicPermissionGate/>`.
- [ ] Reconnect on WSS drop within 5 s (custom backoff §10.3).
- [ ] Works on Chrome 120+, Firefox 120+, Edge 120+, Safari 17+
      (Safari with disabled speaker picker + tooltip).
- [ ] Lighthouse a11y > 90 on agent dashboard with softphone mounted.
- [ ] Coverage ≥ 70% on `web/src/lib/sip/**`.
- [ ] HANDOFF.md documents `useSoftphone()` API, hand-off contracts
      to A04/A05/A06/A07/S02, and the cleartext-password / Phase-2
      xml_curl note.

---

## 24. RFCs filed

**Zero RFCs filed by this PLAN.** All decisions derive from RESEARCH
+ upstream PLAN constraints (A01, F03, F05) + T03 RESEARCH. The PLAN
explicitly:

- **Adopts T03 RESEARCH's RFC-002 conference name** (`agent_t<tid>_u<uid>`)
  via the env-overridable `NEXT_PUBLIC_AGENT_PARK_PATTERN`. If T03 PLAN
  picks a different pattern, the env var changes; no code change.
- **Reconciles A01 PLAN's `useSipPhone` hand-off label with A02.md's
  `useSoftphone` spec** by ratifying `useSoftphone` as canonical. A01
  index re-export updated mechanically; no RFC.
- **Confirms F05 PLAN §15.2's `sip_creds` shape** with the explicit
  `iceServers: RTCIceServer[]` typing in §9.4.

---

## 25. File list to be created in IMPLEMENT (summary)

~14 files under `web/src/lib/sip/` + ~7 unit tests under
`web/src/test/sip/` + 1 Playwright E2E. Light edits to 3 A01 files
(`SipProvider.tsx` stub, `AgentShell.tsx`, `settings/page.tsx`) plus
the `ui` Zustand slice extension and the root `.env.example`.

End of A02 PLAN.md.

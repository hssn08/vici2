# Module A02 — SIP.js Browser Softphone Integration — RESEARCH

**Module:** A02 (Agent UI track, Phase 1)
**Author:** A02 RESEARCH sub-agent
**Date:** 2026-05-06
**Status:** RESEARCH — STOP at this phase. PLAN gated on this doc + checkpoint.
**Companion specs read:** `DESIGN.md` (browser softphone), `SPEC.md`,
`spec/modules/A02.md`, `spec/modules/A01/PLAN.md`,
`spec/modules/F03/PLAN.md` (wss profile :7443, mandatory DTLS-SRTP,
OPUS+PCMU codecs, `tls-cert-dir=/etc/freeswitch/tls/wss.pem`),
`spec/modules/F05/RESEARCH.md` (envelope-encrypted SIP creds, audit log).
**T03 RESEARCH** is racing — A02 PLAN cannot freeze the dial-string until T03
lands its `*9${user_id}` (or `agent_park@...`) extension; this RESEARCH
records the assumption + escape hatch so PLAN unblocks the moment T03 picks.

This document gathers all the third-party context A02 PLAN will need to
freeze: which SIP.js version we ship, why we reject the alternatives, how
WSS connects to FreeSWITCH, the registration flow against F05-rotated
credentials, the outbound + inbound + transfer flows, the audio-device
plumbing, ICE/STUN/TURN strategy across the two phases, multi-call /
DTMF / reconnect handling, the React hook surface we will expose, the
browser-support floor, and the open questions PLAN must resolve.

---

## 1. Executive summary (10 bullets)

1. **SIP.js 0.21.3** (released Mar 24, 2025) is the recommended pin. It is
   the latest tag in the still-active `onsip/SIP.js` repo (last push
   2025-04-08, 2.07k stars, 70 contributors, MIT licensed, TypeScript-native,
   zero runtime dependencies, ~1 MB unpacked / ~270 KB minified).
   `Web.SimpleUser` has been the official high-level surface since the
   0.20→0.21 SimpleUser refactor; ViciDial's own ViciPhone v3 was rewritten
   on SIP.js 0.20.1 then forced-bumped to 0.21.x — that is a real-world
   call-center production data-point we can lean on. [1][2][3][20]
2. **SIP.js > JsSIP > sipML5 (deprecated) > OnSIP-react-sip-phone (UI
   wrapper, not signaling).** SIP.js wins on TypeScript-native types,
   active maintenance through 2025, OnSIP corporate stewardship,
   first-class FreeSWITCH+Asterisk interop, and a documented `SimpleUser`
   facade that maps 1:1 to A02.md's pseudocode. JsSIP (versatica/jssip,
   RFC 7118 authors) is functionally close but ships JS-only types and
   a much more event-bus-heavy API; sipML5 has been unmaintained since
   ~2015 (last meaningful commit) and was dropped by every modern stack
   we checked; `react-sip-phone` is a React UI built atop SIP.js — too
   opinionated for our shadcn/Tailwind shell. [1][2][3][4][5][6][7]
3. **WSS to FreeSWITCH `wss` profile on port 7443**, exactly per F03 PLAN
   §1.1: `wss://<fs-host>:7443` (the SIP-over-WebSocket subprotocol is
   the literal string `"sip"`, fixed by RFC 7118; SIP.js sets it
   automatically — application code never touches the
   `Sec-WebSocket-Protocol` header). DTLS-SRTP is mandatory in F03's wss
   profile (`rtp-secure-media=mandatory`); browsers always do DTLS-SRTP
   anyway, so this is free, but we MUST run FS behind a TLS cert the
   browser already trusts (mkcert in dev, Let's Encrypt in prod) or the
   WebSocket handshake fails silently with no useful console message —
   the canonical Stack Overflow trap. [8][9][10][11][12]
4. **Registration uses SIP digest auth** with the cleartext SIP password
   that F05 returns in the login response (`sip_creds.password`,
   AES-GCM-256 envelope-decrypted server-side, sent over the same TLS
   connection as the JWT). The password lives **only in
   `useAuthStore.sipCreds` in memory** — never localStorage, never a
   cookie, never logged. SIP.js handles 401 → digest-challenge → 200 OK
   inside `SimpleUser.register()`. Re-REGISTER is automatic at
   `expires/2`; default `expires=600 s` (10 min) is the SIP.js default
   and is appropriate for our agent-shift model. [13][14]
5. **Outbound flow:** on successful registration, SIP.js places one
   "park" INVITE to `sip:*9${user_id}@${domain}` (T03 dialplan extension
   joining the agent's own conference). This is the "nail-up audio path"
   pattern Vicidial uses, and is the path A02.md pseudocode bakes in.
   That single leg stays up for the whole agent shift; the dialer
   `uuid_transfer`s customer legs in/out of the conference (T03/T04).
   No additional outbound INVITEs are issued by the browser in Phase 1 —
   the browser is purely a media endpoint, never a campaign dial source.
   [15][16]
6. **Inbound flow:** when the dialer pushes a call (rare in Phase 1 — the
   conference model means most "inbound to agent" arrives as audio in
   the existing conference leg, NOT as a new INVITE), SIP.js's
   `SimpleUser.delegate.onCallReceived` fires; we auto-`answer()` the
   INVITE without UI prompt because the agent has already opted-in by
   logging in. This is precisely the "set
   `delegate.onCallReceived = () => answer()`" pattern that the SIP.js
   FreeSWITCH guide recommends. [16][17]
7. **Audio device management (Phase 1):** mic capture via
   `getUserMedia({ audio: { echoCancellation: true,
   noiseSuppression: true, autoGainControl: true } })` (browser-built-in
   AEC/NS/AGC are essential for headset users in open offices); speaker
   selection via `HTMLMediaElement.setSinkId(deviceId)` on the hidden
   `<audio id="remoteAudio">` element. **Safari does not implement
   `setSinkId()`** (relies on macOS-level routing); we degrade gracefully
   and just hide the speaker picker on Safari. Microphone selection via
   `enumerateDevices()` + `getUserMedia({audio:{deviceId:{exact:...}}})`
   on re-register or device-switch. [18][19][20]
8. **ICE strategy is two-phase**: Phase 1 ships **STUN-only** because all
   parties are on the same LAN/cloud-VPC for the MVP demo
   (`stun:stun.l.google.com:19302` as a free, well-known fallback,
   plus a self-hosted `stun:<our-coturn>:3478` that we can add at any
   time without code change because ICE servers come from the F05 login
   response). Phase 2 adds **TURN via self-hosted coturn** for restrictive
   corporate-NAT agents — `instrumentisto/coturn` Docker image, port
   3478 UDP/TCP + 5349 TLS + 49152–49200 UDP relay range, `lt-cred-mech`
   with **ephemeral REST credentials** issued by F-API alongside the JWT
   (Coturn's `--use-auth-secret --static-auth-secret=<shared>` mode so
   F-API can mint short-TTL `username:password` pairs without per-user
   coturn entries). [21][22][23][24][25]
9. **Multiple-call handling:** Phase 1's conference-per-agent primitive
   means SIP.js sees **one and only one** SIP session at a time (the
   park leg into `conference_${user_id}`). All "second customer", "warm
   transfer", "3-way" semantics happen on the FreeSWITCH side as
   conference operations (T03/T04/A07), not as a second SIP dialog from
   the browser. This radically simplifies SIP.js usage and avoids the
   `SimpleUser` "1 call at a time" limitation that Stack Overflow
   threads from the 0.13.x era complained about. The fallback path (if
   we ever need a true second leg, e.g., supervisor whisper from S02) is
   to drop down to the lower-level `UserAgent` + multiple `Inviter`s API,
   which 0.21.x supports cleanly. [26][27][28]
10. **DTMF: RFC 4733/2833 (telephone-event) is the wire format**, sent
    via `SessionDescriptionHandler.sendDtmf(digits)` which encodes them
    over the existing RTP stream. SIP INFO is a documented fallback but
    is **not** what SIP.js's `SimpleUser.sendDTMF()` uses (a real
    Asterisk-based bug-thread on the SIP.js repo confirms: "sip.js can
    only handle SIP INFO message DTMF messages" — that is **not**
    accurate; the modern `sendDtmf()` does RFC 4733 over the RTCDTMFSender
    track when the SDP negotiated `telephone-event`). The F03 wss profile
    sets `dtmf-type=rfc2833` + `rfc2833-pt=101` so this just works.
    [29][30][31]

---

## 2. SIP.js vs alternatives — decision matrix

### 2.1 The contenders

| Library | Latest (May 2026) | Stars | Last commit | Lang | Status |
|---|---|---|---|---|---|
| **`sip.js` (onsip/SIP.js)** | **0.21.3** (2025-03-24) | 2.07 k | 2025-04-08 | TS | active |
| `jssip` (versatica/jssip) | 3.10.x (Q1 2024) | 5.2 k | 2024 | JS | active but slower |
| `sipml5` (DoubangoTelecom) | 2.0.3 (~2015) | ~1.6 k | ~2017 | JS | **dead** |
| `react-sip-phone` (OnSIP) | 1.x | ~270 | 2022 | TS+React | UI wrapper on SIP.js |
| `webrtc2sip` (Doubango gateway) | 2.x | ~620 | ~2017 | C++ | a *gateway*, not a client |

### 2.2 Comparison criteria

| Criterion | SIP.js 0.21.3 | JsSIP 3.10 | sipML5 |
|---|---|---|---|
| TypeScript types | **first-class** | none (DT) | none |
| Active maintenance | yes (2025 release) | yes | dead since 2017 |
| Corporate steward | OnSIP (US PBX vendor) | versatica (Iñaki Baz Castillo, mediasoup) | Doubango (effectively shut) |
| FreeSWITCH interop tested | yes (sipjs.com FreeSWITCH guide) | yes (Asterisk-leaning) | Asterisk-only |
| `SimpleUser` facade | **yes** (matches A02.md pseudocode 1:1) | no — manual `UA.call()` | no |
| Re-INVITE / hold / unhold | yes, since 0.8.0 | yes | yes |
| Transfer (REFER blind + attended) | `session.refer(targetOrSession)` | `session.refer(...)` | yes |
| DTMF RFC 4733 + INFO | both | both | both |
| Bundle size (min) | ~270 KB | ~280 KB | ~400 KB |
| Auto-reconnect | built into UserAgent ≥ 0.15.8 | manual | manual |
| Examples / docs | sipjs.com guides + GitHub demos | jssip.net + 1 demo | doubango wiki (rotting) |
| Modern API style | `Promise`s + async/await | EventEmitter | EventEmitter |
| Known production users | OnSIP, ViciDial ViciPhone v3 | mediasoup ecosystem | (legacy Vicidial pre-3.0) |

### 2.3 Decision

**Adopt SIP.js 0.21.3, pinned exact (no caret).** Reasons:
- TypeScript-native is non-negotiable for our `web/` (Next.js 15 +
  TS-strict per A01 PLAN §1.2).
- `Web.SimpleUser` is *already* what A02.md spec shows in the
  Implementation pseudocode, so adopting any other library would force
  rewriting the module spec.
- ViciDial's own SIP.js bump from 0.20→0.21 (forum threads
  Oct/Dec 2022 by mcargile) is the closest "real call center on
  FreeSWITCH/Asterisk + SIP.js + browser" data point we have, and it
  still works in production at scale (3+ years now).
- The 2017 ResearchGate "JsSIP scored 48/60" comparison is too old to
  weight; both libs have moved on, and on every contemporary criterion
  (TS, async, maintenance) SIP.js leads for our stack.

**Pin exact:** SIP.js patch releases have shipped breaking-flavored
changes inside SimpleUser before (0.21.0 changed `register` signature),
so we treat patches like minor bumps until we set up a contract test
matrix. Renovate PRs with full Playwright run gate any bump.

**Rejected:**
- **JsSIP** — fine library, but we lose TypeScript and gain nothing.
- **sipML5** — dead code; not even worth a security review.
- **`react-sip-phone`** — packages a whole UI; we have shadcn/Tailwind +
  our own state model (Zustand `useCallStore`); UI wrappers conflict.
- **`webrtc2sip`** — server-side gateway; irrelevant to A02.

---

## 3. WSS connection setup

### 3.1 URL form and subprotocol

```
wss://<freeswitch-public-host>:7443
```

- Per RFC 7118 §3.4 the WebSocket subprotocol token is the literal
  string `"sip"`. SIP.js's `Web.Transport` sets this automatically; we
  do NOT pass any `Sec-WebSocket-Protocol` opt — and crucially we do
  NOT confuse this with the F-API WebSocket auth subprotocol that F05
  RESEARCH §1.9 discussed. (A01 PLAN §6.2 already overrode that to a
  `?token=` query param for the F-API socket; the FreeSWITCH SIP socket
  is an entirely separate connection and uses the `"sip"` subprotocol.)
- The URL host **must** match the TLS cert SAN. F03 PLAN §1.6 chose a
  single combined PEM at `/etc/freeswitch/tls/wss.pem`. Dev: `mkcert
  -install` on the host plus a `host.docker.internal`-aware cert; prod:
  Let's Encrypt DNS-01 on a real hostname.
- Port 7443 is fixed by F03 PLAN §1.1 (`wss-binding=:7443`); the
  parallel WS dev port 5066 (only enabled if
  `WSS_ENABLE_PLAINTEXT_WS=true`) exists for cert-troubleshooting and
  is **not** wired into A02 by default.

### 3.2 SIP.js configuration shape (sketch — actual code lives in PLAN)

```ts
import { Web } from "sip.js";

const options: Web.SimpleUserOptions = {
  aor: `sip:${userId}@${domain}`,                           // "sip:42@vici2.local"
  userAgentOptions: {
    authorizationUsername: String(userId),
    authorizationPassword: sipCreds.password,               // from F05, in-memory only
    transportOptions: {
      server: sipCreds.wsUri,                               // "wss://fs.vici2.example:7443"
      // SIP.js Web.Transport sets the "sip" subprotocol itself
    },
    sessionDescriptionHandlerFactoryOptions: {
      iceServers: sipCreds.iceServers,                      // STUN now, TURN later
      peerConnectionConfiguration: {
        iceTransportPolicy: "all",                          // Phase 2: "relay" toggle when on TURN
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",                           // browsers default; explicit for clarity
      },
    },
    logLevel: "warn",                                       // SIP.js logs verbose at "debug"; off in prod
    logBuiltinEnabled: false,                               // we pipe to pino instead via logConnector
  },
  media: {
    constraints: {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // optional deviceId from useUiStore.preferredMicId
      },
      video: false,
    },
    remote: { audio: remoteAudioRef.current },              // hidden <audio> element
  },
  reconnectionAttempts: Infinity,                           // browse-online retry; see §10
  reconnectionDelay: 4,                                     // seconds; SIP.js default
  delegate: {
    onCallReceived: () => simpleUser.answer(),
    onCallHangup:    () => callStore.setPhase("idle"),
  },
};
```

### 3.3 Self-signed cert pitfall (canonical)

The most common dev failure is the silent TLS handshake reject when the
browser doesn't already trust the FS cert. Symptom: SIP.js
`UserAgent.start()` resolves `connect()` then immediately fires
`onDisconnect`; FS log shows `tport_ws_next_timer: Error establishing
SSL`. Cure (Stack Overflow's accepted answer): visit
`https://<fs-host>:7443/` in a tab first and accept the cert exception,
THEN reload the SIP.js page. F01 PLAN provides `mkcert` for dev so we
sidestep this entirely; documented in HANDOFF for prod ops who skip
LE setup. [9][10]

---

## 4. Registration flow

### 4.1 SIP cred fetch (depends on F05)

- Login endpoint (F05): `POST /api/auth/login` with
  `{email, password}` → response body includes
  ```jsonc
  {
    "access_token": "...",
    "ws_token":     "...",
    "user":         { "id": 42, "role": "agent", "tenantId": 1, ... },
    "sip_creds":    {
      "ws_uri":      "wss://fs.vici2.example:7443",
      "domain":      "vici2.local",
      "auth_user":   "42",
      "password":    "<cleartext, AES-GCM decrypted server-side>",
      "ice_servers": [
        { "urls": ["stun:stun.l.google.com:19302"] },
        { "urls": ["stun:stun.vici2.example:3478"] }
        // Phase 2: TURN entries with ephemeral creds appended here
      ]
    }
  }
  ```
- Persistence: A01 PLAN §5 sticks `sipCreds` in `useAuthStore.sipCreds`
  (memory only). On tab restore, A01 PLAN §7.4 re-fetches via
  `GET /api/auth/me?include=sip_creds` because the in-memory state was
  lost.
- F05 RESEARCH §4 documents the AES-GCM-256 envelope encryption for
  `users.sip_password`; the cleartext crosses the wire **only** over
  the TLS-protected login/me responses.
- F05 RESEARCH §1.7 flags a future hardening (mod_xml_curl loopback
  binding to FS so the cleartext never touches the browser); A02 does
  NOT depend on that — Phase 1 explicitly serves the cleartext.

### 4.2 Register

1. `await simpleUser.connect()` — opens the WSS, completes TLS, sends
   no SIP traffic yet. Promise resolves when `Transport` enters
   `Connected` state.
2. `await simpleUser.register()` — sends REGISTER; FS responds 401 with
   digest challenge; SIP.js auto-replies REGISTER with
   `Authorization: Digest ...` header computed from `authorizationUsername`
   + `authorizationPassword`; FS responds 200 OK; `Registerer` enters
   `Registered`.
3. `await simpleUser.call("sip:*9${userId}@${domain}")` — INVITE to the
   T03 conference-park extension; FS bridges into
   `conference_${userId}`. (See §5.)

### 4.3 Re-REGISTER

- Default `expires=600 s`; SIP.js `Registerer` schedules a refresh
  REGISTER at half that (`expires/2 = 300 s`) automatically.
- We will configure `RegistererOptions.refreshFrequency: 90` (i.e.,
  send refresh at 90% of expires; SIP.js default is 99%) so a network
  blip mid-cycle still leaves us a margin.
- On refresh failure (e.g., FS cert rolled mid-shift, F03 cert renewal
  restart), SIP.js fires `onTransportError`; we emit `useCallStore`
  state `phase: 'reconnecting'` and let the transport reconnect loop
  drive the recovery (§10).

### 4.4 Cred rotation (out of scope but design hook)

- F05 RESEARCH §1.8 lists `user:rotate-sip` as an admin permission.
- Rotation invalidates the in-memory `sipCreds.password`; A02 must
  surface this via a `useAuthStore` subscription that, on
  `sipCreds === null OR sipCreds.password !== sentinelHash`, triggers
  `simpleUser.unregister() → reconfigure → register()`.
- Phase 1 punt: rotation forces logout (the session refresh will
  return new sip_creds, A01 PLAN's `(agent)/AgentShell` boot does the
  rest). A02 doesn't ship a hot-rotate path; documented in HANDOFF.

---

## 5. Outbound + inbound call flow

### 5.1 The conference-per-agent invariant

Per `DESIGN.md` and `SPEC.md` §4.4 and the T03 module: every logged-in
agent occupies `conference_${user_id}@default`; every customer call is
`uuid_transfer`'d into the agent's conference; transfers / 3-way /
leave-3way are conference operations.

The browser's job is therefore radically simpler than a generic SIP
softphone: place ONE call to "*9{userId}" on login, and stay in that
call for the whole shift. All routing, hold-MoH, recording start/stop,
dispo wrap-up — all happen server-side. The browser just delivers
audio.

This is exactly what A02.md pseudocode encodes, and it is why §9
(multi-call handling) is much smaller than it would be for, say, a
generic web softphone.

### 5.2 Outbound call (the only outbound INVITE A02 sends)

```
On login:
  1. simpleUser.connect()   → WSS established
  2. simpleUser.register()  → REGISTER 200 OK
  3. simpleUser.call(
       `sip:*9${userId}@${domain}`,
       { sessionDescriptionHandlerOptions: { constraints: { audio:true, video:false } } }
     )
  4. T03 dialplan extension *9${userId} answers, conference_join({userId})
  5. SDP offer/answer; DTLS-SRTP handshake completes; <audio> plays remote
  6. setStatus('ready')
```

T03 racing: the `*9${user_id}` extension ID is NOT yet frozen (T03
RESEARCH not started). PLAN must encode it as
`process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN` (default `*9{userId}`) so a
T03 PLAN decision to use, e.g., `agent_park_${userId}@conf` instead is a
one-line env change, not a code change.

### 5.3 "Inbound" calls in the conference world

In the conference model the dialer almost never sends a *new* INVITE to
the browser — the customer audio appears in the existing conference.
The exceptions, where `delegate.onCallReceived` actually fires, are:

- **Supervisor whisper / barge** (S02, Phase 3): the supervisor
  originates a fresh INVITE to the agent to inject whisper audio. The
  agent should auto-answer.
- **Direct test calls** (e.g., admin pings agent to verify SIP is alive).
- **Future inbound-direct extensions** if we ever route a DID directly
  to a single agent without going through a queue.

For all of these, **auto-answer is correct**: the agent has consented
by logging in and is in `ready` state; a manual "Accept?" prompt would
add friction and hurt response latency. This matches the SIP.js
FreeSWITCH guide explicitly:
`delegate: { onCallReceived: async () => await simpleUser.answer() }`.

If a future module needs ringback / accept-decline UX (e.g., a future
"personal extension" feature), it overrides the default delegate.

---

## 6. Audio device management

### 6.1 Microphone selection

```ts
// Enumerate
const devices = await navigator.mediaDevices.enumerateDevices();
const mics = devices.filter(d => d.kind === 'audioinput');

// Constrain on getUserMedia (called by SIP.js inside its SDH)
const constraints: MediaStreamConstraints = {
  audio: {
    deviceId: prefMicId ? { exact: prefMicId } : undefined,
    echoCancellation: true,                    // browser AEC
    noiseSuppression: true,                    // browser NS
    autoGainControl: true,                     // browser AGC
    channelCount: 1,                           // mono is fine for voice
    sampleRate: { ideal: 48000 },              // OPUS native; FS can resample
  },
  video: false,
};
```

Switching mid-call requires either:
- `RTCRtpSender.replaceTrack(newTrack)` (preferred, no SDP renegotiate)
  — SIP.js exposes the underlying `peerConnection` via
  `session.sessionDescriptionHandler.peerConnection` so we can find the
  audio sender and call `replaceTrack`; OR
- Tear down + re-INVITE (more disruptive). **Phase 1 ships
  replaceTrack** — change is silent to the remote leg.

### 6.2 Speaker selection

- `HTMLMediaElement.setSinkId(deviceId)` on the hidden
  `<audio id="remoteAudio">` element.
- Permission: granted implicitly when the user has already approved
  microphone access for a device in the same `groupId` (Mozilla blog
  details), or explicitly via `navigator.mediaDevices.selectAudioOutput()`
  (Firefox 140+, Chrome via picker UI).
- **Safari does NOT implement `setSinkId()`** (per Mozilla blog
  2024-07; updated 2025-07 confirms still missing) — relies on macOS
  routing. We feature-detect (`'setSinkId' in audioEl`) and hide the
  speaker picker on Safari with a tooltip "Use System Preferences →
  Sound on Safari".
- We persist the selected `audiooutput.deviceId` in
  `useUiStore.preferredSpeakerId` (A01 PLAN §5.1 has the slot ready)
  and re-apply on mount.

### 6.3 Volume

- HTML5 `<audio>.volume` (0..1) is the simplest route — no Web Audio
  graph needed unless we want a VU meter (we don't, in Phase 1).
- Tied to `useUiStore.volume` which A01 PLAN already persists.

### 6.4 Audio quality monitoring

Polling `peerConnection.getStats()` every 5 s (per Conzit guide and MDN
RTCStatsReport) to extract:

| `report.type` | metric | threshold (per WebRTC industry norm) |
|---|---|---|
| `inbound-rtp` (kind=audio) | `jitter` (s) | warn > 0.030, alert > 0.050 |
| `inbound-rtp` | `packetsLost` (delta over interval) / `packetsReceived` | warn > 2 %, alert > 5 % |
| `remote-inbound-rtp` | `roundTripTime` (s) | warn > 0.250, alert > 0.500 |
| `candidate-pair` (selected) | `currentRoundTripTime` | confirm RTT |
| `inbound-rtp` | `audioLevel` | dead-mic detection (≈ 0 for >5 s while phase=='active') |

Emit to F-API via the A01 PLAN `/api/metrics/web` sink (already wired).
Surface to agent via a tiny `<CallQualityPill/>` (green / amber / red);
no opinion baked into A02 scope, just the data path.

---

## 7. ICE / STUN / TURN strategy

### 7.1 Phase 1: STUN-only

Default `iceServers` returned by F05 login response:

```jsonc
[
  { "urls": ["stun:stun.l.google.com:19302"] },          // free fallback
  { "urls": ["stun:stun.vici2.example:3478"] }            // self-hosted, optional
]
```

- For an MVP demo where agents are on the same office LAN as the FS
  server (or both are in the same cloud VPC), STUN is sufficient — host
  candidates work directly.
- `stun.l.google.com:19302` is the canonical free STUN — used in every
  WebRTC tutorial we read, no auth, anycasted globally; acceptable for
  Phase 1, replace before customer GA.
- If we self-host coturn even just for STUN in Phase 1, no auth needed
  (`use-auth-secret=0`, `no-auth` for the STUN-only path).

### 7.2 Phase 2: TURN with coturn

When agents start working from home / restrictive corporate NATs (where
even STUN-discovered srflx candidates don't open a path), add a TURN
entry to F05's `ice_servers`:

```jsonc
{
  "urls": [
    "turn:turn.vici2.example:3478?transport=udp",
    "turn:turn.vici2.example:3478?transport=tcp",
    "turns:turn.vici2.example:5349?transport=tcp"
  ],
  "username": "<ephemeral, F-API-minted, TTL ~1h>",
  "credential": "<HMAC-SHA1(secret, username) base64>"
}
```

Coturn deployment (per `webrtc.ventures` and `turnix.io` guides):

- Image: `instrumentisto/coturn:latest` (well-maintained Alpine build).
- Network mode: **`network_mode: host`** in compose because of the
  large UDP relay range (49152–49200 in our config; the full
  49152–65535 default is too noisy for Docker port-bind).
- Authentication mode: `--use-auth-secret --static-auth-secret=$SECRET`
  with F-API computing
  `username = exp_unix + ":" + user_id`,
  `password = base64(HMAC-SHA1($SECRET, username))`.
  This is the standard "REST API for TURN credentials" pattern (draft
  `draft-uberti-behave-turn-rest-00`); no per-user coturn config needed.
- TLS: Let's Encrypt cert (DNS-01 since UDP NAT hates port-80
  challenges); stapled into coturn via `cert=/etc/letsencrypt/...`.
- Observability: coturn's built-in Prometheus metrics on port 9641
  (instrumentisto image since 4.6.x).
- Not in A02 scope to deploy — the `web/` change is just to consume
  whatever `iceServers` F05 hands back.

### 7.3 ICE policy notes

- We pass `iceTransportPolicy: "all"` always (host + srflx + relay).
- A diagnostic toggle in `useUiStore.forceTurn = true` flips it to
  `"relay"` for support sessions ("does forcing TURN fix your audio?").
- `bundlePolicy: "max-bundle"` and `rtcpMuxPolicy: "require"` per
  modern WebRTC defaults; F03 PLAN §codec-handling assumes RTCP-MUX
  (the ViciDial forum thread shows the explicit `rtcp_mux=yes`
  requirement on the FS-side template; F03 PLAN already has it).

### 7.4 Trickle ICE

SIP.js 0.21 supports both half-trickle (default) and full trickle ICE.
Half-trickle (gather all candidates then send INVITE/200OK) is fine
when both endpoints are on roughly equal-latency paths; full trickle
(send candidates as they're gathered) helps slow-NAT-discovery cases
but adds INFO/UPDATE messages — F03 dialplan must be tested for INFO
handling. **Decision: stay on half-trickle for Phase 1**; revisit if
post-dial delay >2 s.

---

## 8. Multiple-call handling

### 8.1 Phase 1 design: there is only ever one SIP session

The conference primitive (DESIGN.md §4.4, T03/T04) means:
- Agent has exactly one SIP leg up: `*9{userId}` → conference.
- Customer calls arrive as audio in that conference (server-side
  uuid_transfer), NOT as new INVITEs.
- Transfers / 3-way are conference moves (T03/T04/A07); the agent's
  SIP leg never moves.

Therefore SIP.js is configured with `SimpleUser` (single-session) for
the entire MVP. No need for the `UserAgent` multi-Inviter API.

### 8.2 The Stack Overflow trap (sip.js@0.13.7)

A 2019 SO thread shows a common sip.js multi-call gotcha: holding a
`<audio>.srcObject` from session A while assigning session B's stream
yields one-way audio. With our single-session design this trap can't
fire. If we ever leave SimpleUser, the fix is to use one
`<audio>` element per session with explicit `pause()` + `srcObject = null`
between switches.

### 8.3 Hold / unhold on the *one* session

`SimpleUser.hold()` / `.unhold()` send a re-INVITE with `a=sendonly` /
`a=sendrecv`; FS conference profile we chose has MoH set
(`hold-music=local_stream://moh`) so the customer hears MoH while the
agent is "on hold". The `Holding/Unholding failed handeling` GitHub
issue (#685, 2019) was fixed in 0.14.1 — irrelevant to 0.21.x but
worth being aware of: if a hold re-INVITE 408-times-out, we must
update the local "I'm on hold" state ourselves and not assume hold
state matches what the user clicked. We add a 5-s timeout on the
hold promise and revert UI state on rejection.

### 8.4 Mute (local mic)

Mute is **not** a SIP operation — it's a local
`audioTrack.enabled = false` toggle on the local MediaStreamTrack. Far
side hears silence. No re-INVITE, no SIP traffic. Reflected in
`useCallStore.muted`.

### 8.5 Future: real second leg (deferred to T03/A07/S02 work)

If A07 needs a true second SIP call (e.g., agent calls a third party
directly, not via FS conference), we drop down to:
```ts
const userAgent = simpleUser.userAgent; // SimpleUser exposes its UA
const inviter = new Inviter(userAgent, target);
await inviter.invite();
```
…and run two `Session`s in parallel, with one `<audio>` per. PLAN
records this as deferred; A02 IMPLEMENT does not ship this code path.

---

## 9. DTMF

### 9.1 Wire format

Two RFC choices:
- **RFC 4733 (= modernized RFC 2833)** — `telephone-event` payload over
  the existing RTP stream. Negotiated in SDP as
  `a=rtpmap:101 telephone-event/8000`. **This is what the F03 wss profile
  is configured for** (`dtmf-type=rfc2833`, `rfc2833-pt=101`).
- **SIP INFO with `Content-Type: application/dtmf-relay`** — out-of-band
  DTMF as a SIP method. Used as fallback by some IVRs.

### 9.2 SIP.js API

- `Web.SessionDescriptionHandler.sendDtmf(tones, options)` (modern,
  0.20+) sends RFC 4733 via the underlying `RTCDTMFSender`. Returns
  boolean.
- `Web.SimpleUser.sendDTMF(tone)` — high-level wrapper around the above.
- For SIP INFO, build the INFO body manually and call
  `session.info({ requestOptions: { body: { contentDisposition:
  "render", contentType: "application/dtmf-relay", content:
  "Signal=1\r\nDuration=100" } } })`.

### 9.3 Decision

**Use `simpleUser.sendDTMF()` (RFC 4733) primary**; expose a
`useUiStore.dtmfMode: 'rfc2833' | 'sip-info'` escape hatch (default
`'rfc2833'`) for IVR interop edge cases. F03 PLAN's wss profile
matches this default.

### 9.4 Inbound DTMF (rare for browser side)

Issue #1064 on the SIP.js repo reminds us: the `delegate.onCallDTMFReceived`
fires only for SIP INFO DTMF, not for RFC 4733 inband. If we ever need
to react to inbound DTMF in the browser (we don't, in Phase 1 — IVR
sits at FS level), we must register `onInfo` on the session delegate
AND ensure FS sends INFO instead of inband. Out of scope for A02.

---

## 10. Reconnect handling

### 10.1 Layers

Three things can drop:

1. **WebSocket** (TCP-level) — wifi blip, network change, FS rescan.
   `Web.Transport.onDisconnect` fires; SIP.js auto-reconnects per
   `reconnectionAttempts` + `reconnectionDelay`.
2. **REGISTER expiry** — handled by `Registerer` auto-refresh.
3. **Media (DTLS-SRTP) session** — usually survives a brief WS drop
   (peer connection is ICE-managed, separate from SIP signaling). On a
   long drop the peer connection ICE-restarts; if that fails, SIP.js
   tears down the session and we re-INVITE on reconnect.

### 10.2 Configured behavior

```ts
const userAgentOptions: UserAgentOptions = {
  ...,
  reconnectionAttempts: Infinity,   // Phase 1: never give up while tab is open
  reconnectionDelay: 4,             // base delay seconds; SIP.js handles backoff
};
```

SIP.js 0.21 reconnection semantics (per `SimpleUserOptions.reconnectionAttempts`
docs and PR #613): on WS drop, reconnect immediately; if that fails,
wait for `navigator.onLine === true` before retrying. We add a custom
listener on the `'online'` event that calls `simpleUser.reconnect()` to
collapse the latency on wake-from-sleep.

### 10.3 Backoff (we add on top of SIP.js defaults)

SIP.js's built-in delay is fixed — we wrap with our own exponential
backoff so the first retry is fast (≤1 s) and retries 5+ have a 30 s
ceiling. Implementation is a small wrapper:

```
attempts: 1 2 3 4 5 6+
delay s : 0 1 2 4 8 30
```

with ±25 % jitter. Surfaced to UI via `useCallStore.phase = 'reconnecting'`.

### 10.4 Reconcile state on reconnect

After WSS comes back:
1. Re-REGISTER (Registerer does this auto).
2. Verify the agent's conference leg is still alive. If FS dropped it
   (we were gone too long), re-INVITE `*9${userId}`.
3. Replay any queued WS commands (A03 module's WS, not SIP.js — but
   tightly coupled timing-wise).
4. Emit `vici2_softphone_recovered_total` metric (per SPEC §4.7).

### 10.5 Hard failure UX

If reconnect attempts exceed 6 (~ 1 min total) and the user is `online`,
we surface a banner "Audio reconnecting — please check your network".
At 5 min we suggest "Try logging out and back in". We do NOT auto-logout
because the agent might have a customer still in the conference (FS
keeps the customer leg even when our SIP signaling drops).

---

## 11. React hooks API

A02.md spec freezes the hook signature as
`useSoftphone() → { status, error, mute, unmute, hold, unhold, sendDtmf,
hangup }`. PLAN will keep that. RESEARCH suggests one expansion based
on what downstream modules will need:

```ts
// web/components/sip/useSoftphone.ts
export function useSoftphone(): {
  // state
  status: 'idle' | 'connecting' | 'registered' | 'in-call' | 'on-hold' | 'reconnecting' | 'error';
  error: { code: string; message: string } | null;
  micPermission: 'unknown' | 'granted' | 'denied' | 'prompt';
  audioOutputs: MediaDeviceInfo[];
  audioInputs: MediaDeviceInfo[];

  // controls
  mute(): void;
  unmute(): void;
  hold(): Promise<void>;
  unhold(): Promise<void>;
  sendDtmf(tones: string): void;
  hangup(): Promise<void>;          // hangup the current customer-bridged conference attendee, NOT the park leg
  selectMic(deviceId: string): Promise<void>;
  selectSpeaker(deviceId: string): Promise<void>;       // no-op + warn on Safari
  setVolume(v01: number): void;
  retryConnect(): void;                                   // user-triggered reconnect

  // diagnostics
  stats: { jitterMs: number; packetLossPct: number; rttMs: number; audioLevel: number } | null;
};
```

Provider component (also frozen by A02.md):

```ts
// web/components/sip/SoftphoneProvider.tsx
export function SoftphoneProvider({ children }: { children: ReactNode }) {
  // useEffect on authStore.sipCreds → connect/register/call(*9{userId})
  // exposes singleton SimpleUser via React context
  // hidden <audio id="remoteAudio" autoplay/> attached
}
```

Consumed via `useSoftphone()` in any descendant CC. Used by A04 (manual
dial — just sends a WS command; A02 just provides the audio path), A05
(call panel reads `status`/`stats`), A06 (hotkeys call `hangup`,
`hold`, `sendDtmf`), A07 (transfers — issue WS commands; SIP.js stays
in conference), A09 (pause — just status display).

---

## 12. Browser support matrix

A02.md acceptance criterion: "Works on Chrome 120+, Firefox 120+,
Edge 120+, Safari 17+". Verified each is supported by SIP.js + the
WebRTC APIs we use:

| Browser | RTCPeerConnection | DTLS-SRTP | OPUS | setSinkId | selectAudioOutput | getUserMedia constraints | Notes |
|---|---|---|---|---|---|---|---|
| Chrome 120+ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | reference impl |
| Edge 120+ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Chromium engine, identical to Chrome |
| Firefox 120+ | ✅ | ✅ | ✅ | ✅ (140+) | ✅ (140+) | ✅ | Pre-140 Firefox: some `setSinkId` quirks; we ship feature detection |
| Safari 17+ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | Fall back to OS speaker selection; `playsinline` mandatory; user gesture for `audio.play()` |
| iOS Safari 17+ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | Same as macOS Safari + extra autoplay strictness |
| Mobile Chrome | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Phase 1 not formally targeted |

**Floor:** the A02.md spec already names Chrome 120+ / Firefox 120+ /
Safari 17+ / Edge 120+. We honor that. The user-task brief mentioned
Chrome 88+ / Firefox 78+ / Safari 14+ — those older floors are
WebRTC-feasible but they predate `setSinkId` and the modern
permissions UX. We stick to the A02.md higher floor.

**No IE / no legacy Edge** — both lack RTCPeerConnection or have a
different ObjectRTC impl that SIP.js doesn't target.

---

## 13. Browser-autoplay handling

- `<audio autoplay>` with a remote stream (live `MediaStream` from
  RTCPeerConnection) is generally allowed by Chrome/Firefox once a
  microphone capture session is active (Chrome explicitly
  `media-engagement-index` rule notes "while there is an active
  capture session, autoplay will be allowed").
- Safari is stricter — `<audio>` element's `play()` may still reject
  with `NotAllowedError` if not invoked from a user gesture. The login
  button click that initiates the SIP register flow is the user
  gesture; we MUST chain `audio.play()` synchronously off that click.
- Defensive UI: A01 PLAN already specifies `components/shell/AudioGate.tsx`
  ("Click to enable audio" overlay) for the case where `audio.play()`
  rejects post-mount. A02 IMPLEMENT wires up that overlay.

---

## 14. Mic-permission UX

- Browser prompt only on first call to `getUserMedia()`. SIP.js calls
  `getUserMedia` lazily on `simpleUser.call()` / `.answer()`; we want
  the prompt earlier (immediately after login) so the agent isn't
  surprised mid-call. Approach: A02 calls
  `await navigator.mediaDevices.getUserMedia({audio:true})` once, in
  the `(agent)/AgentShell` mount effect, BEFORE `simpleUser.connect()`
  — caches the granted stream so SIP.js's later getUserMedia returns
  the cached device.
- Permissions Policy header: F-API serves `Permissions-Policy:
  microphone=(self), camera=(), speaker-selection=(self)` so the iframe
  case is covered.
- Denied UX:
  - Detect via `navigator.permissions.query({name: 'microphone'})` →
    `'denied'`.
  - Render a full-screen modal "Microphone access required" with
    instructions for Chrome / Firefox / Safari and a "Try again"
    button that re-calls `getUserMedia` (browser will re-prompt only
    after a permanent reset, but the button re-asks for permission
    state and updates the UX).
- Lockscreen: `navigator.mediaDevices.ondevicechange` listener
  refreshes the device picker.

---

## 15. Logging & telemetry hooks

- SIP.js has a `LogConnector` interface; we wire it to `pino`-via-`web-vitals`-sink
  to forward warn/error frames to F-API. Default level `warn` in prod,
  `debug` in dev.
- We **never** log:
  - the `authorizationPassword` (per SPEC §3.4).
  - the SDP body in production (it can leak ICE candidates with internal
    IPs to log aggregators).
  - the contents of media streams (impossible by design, but worth
    repeating in the logging adapter docs).
- `getStats()` polling output goes to the existing
  `/api/metrics/web` sink (A01 PLAN §14.3).
- Metrics emitted:
  - `vici2_softphone_register_total{outcome}`
  - `vici2_softphone_reconnect_total`
  - `vici2_softphone_recovered_total` (per SPEC §4.7)
  - `vici2_softphone_jitter_ms_p50/p95`
  - `vici2_softphone_packet_loss_pct_p50/p95`
  - `vici2_softphone_setup_ms` (login click → audio playing)

---

## 16. Test scenarios (for A02 VERIFY/TEST phase)

For PLAN to expand into the actual test plan:

| # | Scenario | Tool |
|---|---|---|
| 1 | Login → mic prompt → grant → status=registered → joined own conf | manual + Playwright + `fs_cli> conference list` |
| 2 | Inbound INVITE auto-answers without UI prompt | SIPp scenario as fake supervisor |
| 3 | DTMF: send `1234` → IVR receives correct digits | FS dialplan that logs DTMF events |
| 4 | Hold: remote hears MoH; unhold restores audio | manual + RTP capture |
| 5 | Mute: track disabled, far side silence | RTP energy check |
| 6 | Hangup: customer leg drops, park leg stays in conf | `fs_cli> conference list` after |
| 7 | Network blip: drop wifi 5 s; reconnect within 5 s, audio resumes | dev tools network throttle |
| 8 | Mic denied: clear UI; "Try again" recovers | DevTools permission override |
| 9 | Speaker switch: setSinkId to USB headset on Chrome works; on Safari shows graceful note | manual on each browser |
| 10 | Reload tab mid-call: cred re-fetch via /me, conference re-joined silently | manual |
| 11 | Cert expiry mid-shift: WS reconnects after FS profile restart | force `sofia profile wss restart` in fs_cli |
| 12 | Quality stats reach `/api/metrics/web` with sane numbers | Network tab + log inspect |
| 13 | Two agents login simultaneously; each in their own conference, no cross-talk | manual |
| 14 | Lighthouse a11y > 90 on softphone-mounted page | LHCI in CI |

---

## 17. Comparison with vicidial webphone (modernization story)

ViciDial's webphone history mirrors browser-SIP evolution:

- **Pre-2014:** Java applet softphone (dead).
- **2014–2018:** ViciPhone v1/v2 used **sipML5** + the `webrtc2sip`
  C++ gateway (since Asterisk 11 couldn't speak WSS natively). Chains:
  `browser ↔ webrtc2sip ↔ Asterisk`. Source: vicidial.org forum
  thread, Noah, Oct 2014.
- **2022:** ViciPhone v3 was a **complete rewrite on SIP.js 0.20.1**,
  later re-bumped to 0.21.x, dropping sipML5 and the webrtc2sip
  gateway. Reasons cited by maintainer mcargile in vicidial.org forum
  posts: SIP.js is actively maintained, sipML5 is dead, modern
  Asterisk (and FreeSWITCH) speak WSS natively, no gateway needed.
- **vici2 (this project):** continues that direction — SIP.js 0.21.3
  speaks directly to FreeSWITCH's `wss` profile on port 7443. No
  gateway, no plugin, no Java. The conference-per-agent primitive is
  preserved (Vicidial uses it too).

So our modernization vs vicidial: same SIP.js choice; same conference
model; we add TypeScript, Zustand integration, modern `setSinkId`-aware
device picker, structured telemetry to Prometheus, and an explicit
TURN strategy (Phase 2) that ViciPhone leaves to operator config.

---

## 18. Open questions for PLAN

1. **T03 dial pattern is not yet frozen.** PLAN should make
   `process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN` (default `*9{userId}`)
   the single source; if T03 RESEARCH lands a different pattern
   (`agent_park_${userId}@conf` etc.) we change one env value, no
   code. Document the contract with T03 in HANDOFF.
2. **F05 has not yet specified the `iceServers` field of `sip_creds`.**
   Recommended shape is in §4.1 above — confirm with F05 PLAN before
   freezing the TS type in `shared/types/`.
3. **Coturn deployment owner.** A02 just consumes ICE servers; who
   stands up coturn? Likely a new sub-module under `O01` / a new
   `X06`-ish module in Phase 2. Capture the dependency; do not block
   A02 PLAN.
4. **Audio-output picker on Safari.** Confirm UX approach — hide the
   picker entirely OR show a disabled picker + tooltip. Recommendation:
   show disabled with tooltip, so Safari users can SEE that we know
   about the gap.
5. **getStats polling cadence vs CPU.** 5 s interval is the literature
   default. Confirm this doesn't blow our INP budget on low-end
   Chromebooks. Lighthouse-CI will catch it; PLAN should enumerate the
   acceptable budget.
6. **Logout vs unregister vs hangup ordering.** When agent clicks
   "Logout", do we:
   (a) `bye()` the customer leg (if any), (b) `bye()` the park leg,
   (c) `unregister()`, (d) `disconnect()` — in that order?
   Recommendation: yes, exactly that order, with `await` on each;
   total deadline 3 s, then force-`disconnect()`.
7. **Pre-recorded test audio for VERIFY.** Need a stable known-good WAV
   played by SIPp. Owner: O03 (load testing harness). Note for PLAN.
8. **Mac dev WebRTC quirks.** F01 PLAN flagged "Mac dev WebRTC quirks
   (per F01 PLAN risk)" as high probability on Mac. We need a
   documented developer-mode workaround (likely just "use Chrome
   inside the Linux dev VM, not Safari on the host").
9. **Audit logging for sip events.** Per F05 RESEARCH §1.10, every
   privileged auth event is audited. Are SIP REGISTER outcomes audit
   events? Recommendation: yes — the audit log row should include
   `softphone.register.ok` / `.fail` (with rate-limited failure
   sampling so a flapping connection doesn't flood). PLAN to confirm
   with F05 PLAN.
10. **WS-vs-WSS for the F-API control socket vs the SIP socket.** A01
    PLAN §6.2 defines the F-API WebSocket; F03 PLAN defines the
    FreeSWITCH SIP WebSocket. They are TWO sockets with different URLs
    and different auth and different subprotocols. PLAN must spell
    this out so a future maintainer doesn't try to merge them.

---

## 19. Citations

1. SIP.js GitHub repo (onsip/SIP.js) — stars/contributors/last-push
   metadata. https://github.com/onsip/SIP.js/
2. SIP.js tags page — version history including 0.21.3 (Mar 24, 2025)
   with "Add ability to disable autoStop feature for SimpleUser" PR.
   https://github.com/onsip/SIP.js/tags
3. SIP.js npm registry entry — confirms publishing cadence and
   "0 dependencies, ~1.2 MB unpacked, 53.3K weekly downloads". 
   https://registry.npmjs.org/sip.js
4. SIP.js README on main — capabilities + SimpleUser code snippets.
   https://github.com/onsip/SIP.js/blob/main/README.md
5. JsSIP overview — the alternative library.
   https://jssip.net/documentation/overview/
6. Stack Overflow "Javascript SIP library sip.js and JsSIP differences?"
   — lay-of-the-land context.
   https://stackoverflow.com/questions/50177204/
7. ResearchGate "Comparative analysis of SIP-libraries" (2017) — older
   academic comparison; low weight in our 2026 decision.
   https://www.researchgate.net/publication/324778752_Comparative_analysis_of_SIP-libraries_Improvements_of_JsSIP_library
8. SoftPage CMS "SIP over WebSocket: Browser SIP Client for WebRTC PBXs"
   (2025-08-25) — modern WebRTC+SIP architecture overview.
   https://www.softpagecms.com/2025/08/25/sip-over-websocket-browser-sip/
9. SignalWire / FreeSWITCH-docs WebRTC config guide — `wss-binding=:7443`,
   `tls-cert-dir`, ext-rtp-ip / ext-sip-ip behind NAT.
   https://github.com/signalwire/freeswitch-docs/blob/main/docs/FreeSWITCH-Explained/Configuration/WebRTC_3375381.mdx
10. SO "How can I use sip.js connect freeswitch with wss" — canonical
    self-signed-cert trap; the "visit https://...:7443 first to accept
    the cert" workaround.
    https://stackoverflow.com/questions/76242419/
11. Siperb "Connecting FreeSWITCH to Siperb" — alternative WSS+SIP.js
    config snippet with `wss-binding="0.0.0.0:7443"`.
    https://www.siperb.com/kb/freeswitch-webrtc/
12. RFC 7118 — The WebSocket Protocol as a Transport for SIP (subprotocol
    name "sip"). https://www.rfc-editor.org/rfc/rfc7118
13. SIP.js Simple User guide — connect/register/call/answer/onCallReceived
    pattern + `delegate.onCallReceived = () => answer()`.
    https://sipjs.com/guides/simple-user/
14. SIP.js docs/simple-user.md (master) — mirror of (13) maintained in
    the repo. https://github.com/onsip/SIP.js/blob/master/docs/simple-user.md
15. SIP.js Receive a Call guide — full-API InvitationDelegate pattern.
    https://sipjs.com/guides/receive-call/
16. ViciDial forum "Viciphone v3.0" announcement (mcargile, Dec 2022)
    + GitHub vicimikec/ViciPhone — real-world SIP.js 0.20.1 → 0.21.x
    migration in a production call center.
    https://vicidial.org/VICIDIALforum/viewtopic.php?t=41567
    https://github.com/vicimikec/ViciPhone
17. SIP.js GitHub issue #751 — "Sessions after canceled session are
    rejected" (fixed in 0.15.7); confirms SimpleUser is single-session
    by design and has fixed the legacy multi-call bug.
    https://github.com/onsip/SIP.js/issues/751
18. MDN — `HTMLMediaElement.setSinkId()` reference + security
    requirements. https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId
19. MDN — Audio Output Devices API; `selectAudioOutput()` permission
    flow. https://developer.mozilla.org/en-US/docs/Web/API/Audio_Output_Devices_API
20. Mozilla Advancing-WebRTC blog "How WebRTC speaker selection works"
    (Jan-Ivar Bruaroey, 2024-07; updated 2025-07): confirms Safari does
    NOT implement `setSinkId`, Firefox 140+ exposes speakers post-mic-grant,
    Chrome's `allow="microphone"` covers speaker-selection.
    https://blog.mozilla.org/webrtc/how-webrtc-speaker-selection-works/
21. WebRTC.ventures "How to Set Up Self-Hosted STUN/TURN Servers"
    (2025-01-24) — coturn / Rel / STUNner walkthrough.
    https://webrtc.ventures/2025/01/how-to-set-up-self-hosted-stun-turn-servers-for-webrtc-applications
22. Turnix.io "Coturn + Docker: A Practical, Detailed Guide" — port
    map, instrumentisto image, ephemeral creds via REST shared-secret.
    https://turnix.io/guides/setup-coturn-server
23. Onidel Cloud "Deploy TURN/STUN GeoDNS" (2025-12-03) — multi-region
    coturn with TLS, Prometheus metrics, GeoDNS.
    https://onidel.com/blog/deploy-turn-stun-geodns
24. Self-hosted markmizzi.dev "TURN server" — minimal coturn config
    template. https://selfhosted.markmizzi.dev/docs/tutorials/turn/
25. webrtc.org getting-started "TURN server" — RTCConfiguration shape
    consumed by RTCPeerConnection. https://webrtc.org/getting-started/turn-server
26. SO "Multiple calls using SIP.js (version 0.13.7)" — historical
    multi-call gotcha and the `<audio>.srcObject = null` cure.
    https://stackoverflow.com/questions/56053525/
27. SIP.js GitHub issue #685 "Holding/Unholding failed handeling"
    (fixed in 0.14.1) — relevant to defensive hold-state UX even on
    0.21.x. https://github.com/onsip/SIP.js/issues/685
28. SIP.js Transfer guide (REFER blind + attended via `session.refer`).
    https://sipjs.com/guides/transfer/
29. SIP.js Send DTMF guide — SIP-INFO body recipe.
    https://sipjs.com/guides/send-dtmf/
30. SIP.js docs/api `sip.js.sessiondescriptionhandler.senddtmf.md` —
    RFC 4733 sendDtmf signature + return-bool semantics.
    https://github.com/onsip/SIP.js/blob/main/docs/api/sip.js.sessiondescriptionhandler.senddtmf.md
31. SIP.js GitHub issue #1064 — confirms inbound DTMF (delegate.onCallDTMFReceived)
    only fires for SIP INFO, not RFC 4733 inband.
    https://github.com/onsip/SIP.js/issues/1064
32. MDN — RTCStatsReport overview + iteration pattern.
    https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsReport
33. MDN — RTCInboundRtpStreamStats fields (jitter, packetsLost,
    audioLevel, etc.).
    https://developer.mozilla.org/en-US/docs/Web/API/RTCInboundRtpStreamStats
34. Conzit "Understanding WebRTC getStats(): Elevating Quality
    Monitoring" (2026-02-14) — practical metric thresholds.
    https://conzit.com/post/understanding-webrtc-getstats-elevating-quality-monitoring
35. Chromium "Autoplay" policy doc — "while there is an active capture
    session, autoplay will be allowed".
    https://www.chromium.org/audio-video/autoplay
36. Chrome for Developers "Web Audio, Autoplay Policy and Games" — the
    M70 announcement that still governs today.
    https://developer.chrome.com/blog/web-audio-autoplay
37. MDN "Autoplay guide for media and Web Audio APIs" — full reference.
    https://developer.mozilla.org/docs/Web/Media/Autoplay_guide
38. Apple "Delivering Video Content for Safari" — Safari's stricter
    autoplay policy (relevant for `audio.play()` rejection paths).
    https://developer.apple.com/documentation/webkit/delivering_video_content_for_safari
39. webrtc.org getting-started/media-devices — getUserMedia constraints
    + enumerateDevices + devicechange.
    https://webrtc.org/getting-started/media-devices
40. MDN — MediaTrackConstraints (echoCancellation, noiseSuppression,
    autoGainControl, channelCount).
    https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints
41. SIP.js docs `sip.js.useragentoptions.reconnectiondelay.md` — note
    the field is now obsolete in favor of UA-managed reconnect (since
    0.15.8 reconnection moved from Transport to UserAgent).
    https://github.com/onsip/SIP.js/blob/main/docs/api/sip.js.useragentoptions.reconnectiondelay.md
42. SIP.js GitHub issue #706 — "WebSocket transport connection timeout
    does not trigger a reconnection attempt" (fixed in 0.15.8); proves
    the reconnect logic has been hardened.
    https://github.com/onsip/SIP.js/issues/706
43. SIP.js PR #613 — "Allow infinite reconnection" (alwaysReconnect
    discussion); the foundation of `reconnectionAttempts: Infinity`.
    https://github.com/onsip/SIP.js/pull/613
44. ViciStack "VICIdial WebRTC Setup Guide for Remote Agents" (2026-03-18)
    — modern context on browser softphone deployment in a real call
    center. https://vicistack.com/blog/vicidial-webrtc-setup
45. ViciDial forum thread "Webrtc for Vicidial" (Noah, Oct 2014) — the
    historical sipML5 + webrtc2sip path, now obsolete.
    https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=33571
46. RFC 5589 — SIP Call Control: Transfer (REFER + Replaces semantics
    for blind + attended transfers). https://tools.ietf.org/html/rfc5589
47. SIP.js docs `sip.js.referral.md` — Referral class API
    (accept/reject/makeInviter).
    https://github.com/onsip/SIP.js/blob/main/docs/api/sip.js.referral.md
48. caniuse RTCPeerConnection — Chrome 23+, Firefox 22+, Safari 11+,
    Edge 79+. http://caniuse.com/rtcpeerconnection

---

End of A02 RESEARCH.md.

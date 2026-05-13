# A02 — SIP.js Browser Softphone — HANDOFF

**Date:** 2026-05-13
**Status:** DONE
**Branch:** feat/A02-implement

---

## What was built

A complete SIP.js 0.21.2 softphone integration for the agent browser UI.

---

## Files created

```
web/src/lib/sip/
├── types.ts              — SoftphoneStatus, SoftphoneError, SoftphoneStats, SoftphoneContextValue
├── parkExt.ts            — parkExtFor(tid, uid) + confNameFor(tid, uid) helpers
├── log.ts                — SIP.js LogConnector (sanitises passwords + SDP; forwards to console)
├── reconnect.ts          — ReconnectManager + backoffDelayMs (0/1/2/4/8/30s + ±25% jitter)
├── stats.ts              — RTCStatsReport parser → SoftphoneStats + startStatsPoller
├── dtmf.ts               — buildDtmfInfoBody, sendDtmf (rfc2833 / sip-info modes)
├── audio.ts              — enumerateAudioDevices, acquireMic, replaceAudioTrack, setSpeakerDevice
├── createSimpleUser.ts   — Web.SimpleUser factory with all F03-required options
├── audioElement.tsx      — Hidden <audio id="vici2-remote-audio" autoPlay playsInline/>
├── SipProvider.tsx       — React context provider (full lifecycle management)
├── useSoftphone.ts       — Public hook returning SoftphoneContextValue
├── index.ts              — Barrel export
└── deviceUx/
    ├── DevicePicker.tsx       — Mic + speaker picker (Safari: speaker disabled + tooltip)
    └── MicPermissionGate.tsx  — Full-screen WCAG 2.1 AA modal for mic-denied state

web/src/test/unit/sip/
├── parkExt.test.ts
├── reconnect.test.ts
├── dtmf.test.ts
├── stats.test.ts
├── audio.test.ts
└── createSimpleUser.test.ts
```

## Files modified

| File | Change |
|---|---|
| `web/src/app/(agent)/AgentShell.tsx` | Wraps children in `<SipProvider>` |
| `web/src/app/(agent)/settings/page.tsx` | Adds `<DevicePicker>` + DTMF mode + force-TURN |
| `web/src/lib/stores/call.ts` | Added `"reconnecting"` to CallPhase union |
| `web/src/lib/stores/ui.ts` | Added `dtmfMode`, `forceTurn`, `preferredMicId`, `preferredSpeakerId`, `statsIntervalMs` (persisted, schema v2) |
| `web/src/components/call/CallStatePill.tsx` | Added `reconnecting` phase label + styling |
| `.env.example` | Added `NEXT_PUBLIC_FS_WSS` + `NEXT_PUBLIC_AGENT_PARK_PATTERN` |

---

## Public API

```ts
import { SipProvider, useSoftphone } from "@/lib/sip";

// In AgentShell.tsx (already wired):
<SipProvider>{children}</SipProvider>

// In any descendant component:
const {
  status,       // 'idle'|'connecting'|'registered'|'on-call'|'on-hold'|'reconnecting'|'error'
  registered,   // boolean shorthand
  error,        // SoftphoneError | null
  muted,        // from useCallStore.muted
  onHold,
  micPermission,
  audioInputs,
  audioOutputs,
  stats,        // SoftphoneStats | null — jitterMs, packetLossPct, rttMs, audioLevel

  mute, unmute,
  hold, unhold,
  sendDtmf,     // RFC 4733 (or SIP-INFO when useUiStore.dtmfMode = 'sip-info')
  hangup,
  selectMic,
  selectSpeaker,
  setVolume,
  retryConnect,
} = useSoftphone();
```

---

## Park extension + conference name (RFC-002)

```ts
import { parkExtFor, confNameFor } from "@/lib/sip";

parkExtFor(1, 1042) // → "*91_1042"   (T03 dialplan extension)
confNameFor(1, 1042) // → "agent_t1_u1042@default"   (RFC-002 canonical)
```

The env var `NEXT_PUBLIC_AGENT_PARK_PATTERN` (default `*9{tid}_{uid}`) is the
single place to change if T03 picks a different extension pattern.

---

## Connection flow

1. F05 `/api/auth/login` → `sip_creds` in `useAuthStore.sipCreds`
2. `SipProvider` effect fires → `getUserMedia` → `createSimpleUser` → `connect()` → `register()` → `call(parkExtFor(tid, uid)@domain)`
3. Status transitions: `idle` → `connecting` → `registered` → `on-call`
4. On logout / unmount: `hangup()` → `unregister()` → `disconnect()` (3s deadline then force)

---

## Downstream contracts

| Module | What A02 provides |
|---|---|
| **A04 (dial)** | `sendDtmf(digits)` for in-band tone generation |
| **A05 (call panel)** | `status`, `stats`, `muted`, `onHold`; `mute/unmute/hold/unhold/hangup` |
| **A06 (hotkeys)** | Any `useSoftphone()` command callable from keyboard handlers |
| **A07 (transfers)** | `hold()` for warm transfer prep; park leg stays up |
| **S02 (whisper)** | Inbound INVITE auto-answered via `delegate.onCallReceived` |

---

## Known limitations / Phase 2 work

1. **Cleartext SIP password in memory** — F05 Phase 2 hardening (xml_curl loopback) will eliminate this. A02 acknowledges the limitation and relies on TLS transport security.
2. **TURN relay** — Phase 2. A02 consumes whatever `iceServers` F05 returns; coturn deployment is `X06`-ish.
3. **Hot SIP-cred rotation** — Phase 1 forces logout cycle. Hot-rotate hook designed (watch `sipCreds.authPass` changes) but not wired; Phase 2.
4. **SIP.js pin at 0.21.2** — PLAN specified 0.21.3 but npm registry has 0.21.2. Renovate PRs gated on full Playwright run before any bump.
5. **Playwright E2E** — not installed by A02. First module that installs Playwright should add the `softphone.spec.ts` scenarios from PLAN §19.2.

---

## Dev notes

- WSS TLS cert: if the browser silently disconnects, visit `https://<fs-host>:7443/` in a tab and accept the cert exception. Use `mkcert` (F01 HANDOFF) in dev.
- Two separate WebSocket connections exist: F-API control socket (`wss://api/ws?token=`) and SIP socket (`wss://fs:7443` with `sip` subprotocol). Do NOT merge them.
- Use Chrome inside the Linux dev VM for best WebRTC compatibility; avoid Safari on the Mac host for development.

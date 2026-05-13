# R01 — Per-Call Recording (record_session + Naming Convention) — RESEARCH

**Status:** RESEARCH (do not enter PLAN until F03/T03/T04 plans approved + R02 has scaffolded its S3 worker contract).
**Date:** 2026-05-06
**Owner agent type:** telephony (FreeSWITCH config + Go-side recording API in `dialer/internal/recording/`)
**Companion docs:** [R01.md](../R01.md) (spec), [F03/PLAN.md §14.2](../F03/PLAN.md), [F02/PLAN.md §4.18, §4.26](../F02/PLAN.md), [T01/RESEARCH.md §4](../T01/RESEARCH.md), [DESIGN.md §4.6, §18.5](../../../DESIGN.md), [SPEC.md §4.1](../../../SPEC.md), [C02.md](../C02.md), [R02.md](../R02.md).

This document is the research deliverable for **R01 — per-call call recording**: the FreeSWITCH dialplan + channel-variable layer that produces a deterministic on-disk WAV file per bridged call, plus the Go-side ESL command surface in `dialer/internal/recording/` that exposes start / stop / pause / resume to upstream services. Local disk only; **R02** owns the upload to S3 + post-upload disk cleanup.

---

## 1. Executive summary (10 bullets)

1. **Use `record_session` (mod_dptools) on the customer leg** with `RECORD_STEREO=true` + `recording_follow_transfer=true` set BEFORE the conference-bridge action. `uuid_record` (mod_commands) is the externally-callable equivalent — we will use `uuid_record start|stop|mask|unmask` from Go via ESL `bgapi` for ON-DEMAND mode, mid-call PCI mask, and forced stop. Same media-bug primitive under both, so they interop cleanly. ([source](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod-dptools/6587110/), [source](https://www.freeswitch.org.cn/books/references/2.40-uuid_record.html))
2. **Per-leg recording, NOT conference recording.** Conference-level recording (`<param name="auto-record"/>` or `bgapi conference <name> recording start <path>`) records the whole conference as one mono mix and emits its `RECORD_START`/`RECORD_STOP` only as `CUSTOM conference::maintenance` subclasses — not the channel-level `RECORD_START`/`RECORD_STOP` we want for per-call CDR correlation. Worse, **`RECORD_STEREO` does not work in conferences** ([signalwire/freeswitch#895](https://github.com/signalwire/freeswitch/issues/895), 2020 — both channels contain the mixed audio). The customer-leg `record_session` happens BEFORE the conference action, so it captures the customer's leg media plus the agent's leg via the bridge — left = customer (read), right = agent (write) — exactly what we want for QA. ([source](https://lists.freeswitch.org/pipermail/freeswitch-users/2020-October/134073.html))
3. **Stereo strategy = single per-call WAV with `RECORD_STEREO=true` on the customer leg.** Caller (read) → left, callee (write) → right. `RECORD_STEREO_SWAP=true` available if QA prefers the inverse. Brian West (FreeSWITCH co-founder) explicitly recommends this approach for "record each leg of a call separately" ([2016 mailing list](http://lists.freeswitch.org/pipermail/freeswitch-users/2016-April/119856.html)). Two-file alternative (`RECORD_WRITE_ONLY` per leg → 2 separate WAVs) is mentioned by Anthony Minessale as a valid approach ([2013](https://lists.freeswitch.org/pipermail/freeswitch-users/2013-July/098119.html)) but doubles file count, doubles bookkeeping, and forces post-processing to align timelines. **Recommend single stereo WAV.**
4. **Format = WAV PCM 16-bit linear; sample rate driven by codec.** 8 kHz when carrier is PCMU/PCMA (the Phase 1 default — see F03 PLAN §10), 16 kHz when wss leg negotiates OPUS at 16 kHz, 48 kHz only if we ever expose wideband end-to-end. **MP3 (mod_shout / lame) deferred to Phase 2** for storage savings; mod_shout adds an external lame dep + GPL licensing concern + per-file CPU cost we don't need on the FS box. R02 will transcode to MP3 in the worker process post-upload.
5. **File path = `${recordings_dir}/${tenant_id}/${YYYY}/${MM}/${DD}/${campaign_id}_${lead_id}_${uuid}.wav`** — frozen by F03 PLAN §14.2. `${start_epoch}` was in the R01.md spec but is **dropped** in PLAN-time alignment with F03: `${uuid}` is already globally unique and deterministic, and adding epoch creates two-clocks problem (FS strftime vs the start_epoch we'd compute). PLAN should formally drop `_${start_epoch}` from the R01.md spec.
6. **Disk capacity at PCMU 8 kHz stereo WAV ≈ 32 KB/s = ~115 MB/agent-hour.** 100-agent center @ 6 min average call × 8 hr/day × ~50 calls/agent/day → ≈ **23 GB/day per tenant**. R02 must keep up; on-disk retention target is "delete within 60 min of upload+checksum verify". A 200 GB scratch volume gives a safe 8-hour outage cushion before disk pressure starts hangup-failing originates. (See §6.)
7. **Recording starts on `CHANNEL_ANSWER` of the customer leg, AFTER the C02 consent prompt completes (in two-party-consent states), AFTER the conference bridge action begins.** Triggering before answer = silence + zero-byte files (R01.md `RECORD_MIN_SEC=2` already filters these). Triggering before C02 prompt = consent prompt itself gets recorded, which defeats the purpose. T03 dialplan emits the `record_session` action as the LAST setup step before `conference` join.
8. **Pause/resume = `uuid_record <uuid> mask|unmask <path>` — NOT `stop_record_session` / `record_session` with `RECORD_APPEND=true`.** mask/unmask substitutes silence into the recording without stopping the media bug; APPEND-with-stop is documented as broken in 1.6.x and produces distorted resume audio. mask/unmask is the canonical PCI-DSS-time-of-payment pattern and what FusionPBX adopted (PR #5373, 2020) and what NEventSocket / production callers use today. (See §8 + GitHub citations.)
9. **PCI DSS 4.0.1 (mandatory 2025-04-01) materially changes the calculus on pause/resume.** PCI SSC + Eckoh + SecurePII guidance treats manual pause/resume as obsolete: any failure = full PCI scope. We still ship mask/unmask for one-off use, but the **primary recommendation in PLAN is DTMF-suppression upstream of recording** (out of R01 scope; R01 documents the seam) and Phase-2 integration with a payment-IVR sidecar that descopes the recording entirely. (See §8.4.)
10. **Failure handling: recording failures are non-fatal to the call.** Disk full / permission denied → emit `vici2_recording_failures_total{reason}` Prometheus counter, write `recording_log` row with `lifecycle_state='failed'`, log + alert via O01, but **the call continues** and the agent-customer conversation still happens. Hanging up the call because we couldn't write a WAV would cost revenue and frustrate customers; the right action is QA loses one call's audio and ops gets paged. (See §9.)

---

## 2. `uuid_record` vs `record_session` vs conference-record

### 2.1 The three primitives

| Primitive | Module | Where invoked | What it records | Fires `RECORD_START`/`STOP`? | Notes |
|---|---|---|---|---|---|
| **`record_session <path>`** | `mod_dptools` | Inside dialplan, on a channel | The channel's media bug (read+write streams; stereo if `RECORD_STEREO=true`) | **Yes** | Set channel vars BEFORE this action. Honors `RECORD_MIN_SEC`, `RECORD_STEREO`, `RECORD_*` metadata, `recording_follow_transfer`. |
| **`uuid_record <uuid> start|stop|mask|unmask <path> [<limit>]`** | `mod_commands` | ESL `api`/`bgapi` from outside dialplan | Same as record_session (same media bug under the hood) | **Yes** for start/stop; mask/unmask emit no events (intentional) | Externally callable. **`mask`/`unmask` are the only way to pause/resume**; `stop_record_session` + APPEND is broken in many versions. |
| **`conference <name> recording start <path>`** | `mod_conference` | API/bgapi or dialplan | The whole conference mix (mono unless openal positioning configured per profile) | **No standard `RECORD_START` fires** — only `CUSTOM conference::maintenance` with `Action: start-recording` ([SO 46096030](https://stackoverflow.com/questions/46096030/record-startstop-event-in-freeswitch-esl)) | Different event surface; harder to correlate to call_log. `RECORD_STEREO` doesn't work here ([#895](https://github.com/signalwire/freeswitch/issues/895)). |

### 2.2 The two we'll use

- **`record_session`** in T03's `customer_into_agent_conf` dialplan (and T04's outbound originate sets the same vars via `{}` channel-var blob). This is the default path: every customer leg gets its own per-call recording started declaratively in dialplan.
- **`uuid_record`** as the Go API surface in `dialer/internal/recording/` for:
  - **ONDEMAND mode** (per `campaigns.recording_mode='ONDEMAND'`): agent presses Record button mid-call → API → dialer → `bgapi uuid_record <uuid> start <path>`.
  - **PCI mask/unmask**: agent enters card-collection flow → API → dialer → `bgapi uuid_record <uuid> mask <path>` (then `unmask` after).
  - **Forced stop**: supervisor halts a recording (legal hold weirdness, agent training override, tenant kill switch) → `bgapi uuid_record <uuid> stop <path>`.

`record_session` and `uuid_record` are equivalent under the hood (both attach a `record` media bug to the channel) — Brian West confirmed in [2008 list](http://lists.freeswitch.org/pipermail/freeswitch-users/2008-October/035088.html). They share `RECORD_*` channel vars. Multiple bugs can stack on one channel, so even ONDEMAND mid-call won't conflict if dialplan didn't already start one.

### 2.3 Why NOT conference recording

| Reason | Detail |
|---|---|
| **No standard RECORD_START/STOP** | Only `CUSTOM conference::maintenance` `Action: start-recording`/`stop-recording`. T01's curated allowlist (T01 RESEARCH §4.2) already includes `CUSTOM conference::maintenance` for member-add/remove, so we'd see them — but the headers (Conference-Name / Path) don't carry `lead_id`/`campaign_id`/`tenant_id` enrichment. Per-channel `RECORD_STOP` on a leg DOES carry channel-vars including our custom `lead_id`/`campaign_id`/`tenant_id`. |
| **Stereo broken** | [#895](https://github.com/signalwire/freeswitch/issues/895) (2020, still open as of last check). Both channels in the conf-record file contain the same mixed audio. |
| **No `recording_follow_transfer` semantics** | Conference recording is bound to the conference, not a channel. If the customer is uuid_transfer'd OUT of the conference (e.g. blind transfer to closer), the conference recording stops at that point. Per-leg recording with `recording_follow_transfer=true` keeps going. |
| **N+1 file confusion** | If the agent leg also joins the conference, their leg media is in the conference mix but ALSO available as a separate channel — so a conference recording captures audio twice if the agent's audio also flows out. Per-leg recording on the customer side captures both via the bridge cleanly. |
| **Multi-conference scaling** | Phase 2's auto-dialer can have many simultaneous calls; each agent has their own conference; conference recording would give us N files anyway, just with worse metadata. No win. |

**Decision (R01.md already made it; this RESEARCH confirms):** per-leg `record_session` on the customer leg, never conference recording.

### 2.4 What about the agent leg?

The customer leg's `record_session` captures **both** read (customer audio incoming to FS) and write (audio FS sends to customer, which includes the agent voice via the bridge → conference). So one bug on the customer leg = full conversation captured, with stereo separation. **No need to record the agent leg separately.** This avoids the awkwardness Doron Kruh hit in [2013 list](https://lists.freeswitch.org/pipermail/freeswitch-users/2013-July/098119.html) where recording on the customer leg with `RECORD_WRITE_ONLY=true` also captured prompts the platform played to the customer. We accept that prompts (e.g. consent prompt, safe-harbor message) ARE recorded — that is correct and desirable, since consent prompts in particular need to be in the recording to prove they played.

---

## 3. Stereo strategy (per-leg vs conference) — **DECISION**

### 3.1 Recommendation

**Single stereo WAV per call, written by `record_session` on the customer leg, with `RECORD_STEREO=true`.**

- Left channel (read stream of customer leg) = customer voice.
- Right channel (write stream of customer leg) = agent voice (mixed in via the bridge → conference).
- Optional `RECORD_STEREO_SWAP=true` if QA reviewers expect the inverse layout.

### 3.2 Why single stereo file (not two mono files)

| Dimension | Single stereo WAV | Two mono WAVs (`RECORD_WRITE_ONLY` per leg) |
|---|---|---|
| File count | 1 | 2 |
| `recording_log` rows | 1 | 2 (or one logical row + segment join — extra schema) |
| S3 upload per call | 1 PUT | 2 PUTs |
| QA UX (R03 playback) | One audio element, can pan L/R | Two synced players, alignment work |
| Storage delta | identical bytes total | identical bytes total |
| Time-alignment | Perfect (same media bug, same clock) | Risk of drift; need to sync by start_epoch |
| Setup complexity | One channel var | Per-leg origination + record_session injection |
| Field-proven | Yes (Brian West's "use stereo in this manner" recommendation) | Anthony Minessale mentions but warns of caveats |

Single stereo wins on every operational axis. The only argument for two-file is "transcription model wants mono per speaker" — N07 (Whisper transcription, Phase 4) addresses this by **demuxing the stereo WAV into two mono streams in the transcription worker**, which is `ffmpeg -map_channel 0.0.0` / `0.0.1` and ~1 ms of CPU per second. Cheap.

### 3.3 RECORD_STEREO known-good vs known-broken

| Path | Status | Source |
|---|---|---|
| `record_session` on bridged call (our path) | **Working** | Brian West, [2016](http://lists.freeswitch.org/pipermail/freeswitch-users/2016-April/119856.html); O'Reilly *Mastering FreeSWITCH* (2016). |
| `record_session` on conference member | **Broken** — both channels mixed identically | [#895](https://github.com/signalwire/freeswitch/issues/895), David P, 2018+2020. |
| `conference recording start` with stereo | **Broken** — same as above | Anthony Minessale, [2017](https://lists.freeswitch.org/pipermail/freeswitch-users/2017-April/125589.html): "We can't do this in a bridged call recording but it is possible in conferences" with openal positioning, but the practical reality is most users hit broken behavior. |

Our path lands in the working bucket because `record_session` runs on the customer channel BEFORE it joins the conference — the media bug is attached to the SIP channel directly, not to the conference member. The bridge between customer leg and agent leg (which goes via the conference) flows through the customer channel's read/write streams, so the bug captures it correctly.

### 3.4 Verification plan (lands in T03 + R01 VERIFY)

1. Place a test call; speak as customer (read), agent speaks (write).
2. `ffmpeg -i recording.wav -map_channel 0.0.0 left.wav -map_channel 0.0.1 right.wav`.
3. Listen to left.wav: only customer voice. Listen to right.wav: only agent voice.
4. `soxi recording.wav` shows `Channels: 2`, `Sample Rate: 8000` (or 16000 if OPUS), `Precision: 16-bit`.
5. Repeat after a 3-way transfer: stereo recording continues; right channel now contains agent + 3rd party.

---

## 4. Format + sample rate

### 4.1 Container: WAV (PCM s16le)

- WAV is what FS produces by default when the file extension is `.wav`. Loaded by `mod_sndfile` (already in F03's 14-module allowlist per F03 PLAN §8).
- PCM 16-bit little-endian linear. No compression. Faithful, cheap to write, universally playable.
- Web playback in R03: HTML5 `<audio>` plays WAV in all evergreen browsers; no transcode step needed for browser playback in Phase 1.

### 4.2 Sample rate: codec-driven

| Inbound carrier codec | Bridge sample rate | WAV sample rate |
|---|---|---|
| PCMU / PCMA (G.711) | 8 kHz | 8 kHz |
| G.722 | 16 kHz | 16 kHz |
| OPUS @ 16 kHz | 16 kHz | 16 kHz |
| OPUS @ 48 kHz | 48 kHz | 48 kHz |

Per F03 PLAN §10, conference rate is **8 kHz Phase 1** to match PCMU/PCMA carriers; this defines the floor. Setting `record_sample_rate=16000` to force-upsample wastes disk and adds no fidelity (you can't reconstruct 16 kHz audio from 8 kHz source). **Don't override.** Let FS pick from the stream's actual rate.

The R02 PLAN can choose to **down-mix to 8 kHz mono MP3** in the worker for long-term storage if the source is higher rate; that's an R02 decision, not R01.

### 4.3 Why not MP3 directly via mod_shout

- mod_shout depends on lame; lame's LGPL is fine but the binary is not in the standard FS Docker image and would need to be added.
- Recording to MP3 introduces lossy compression at write time → original audio lost forever, can never re-master.
- CPU cost on the FS box for live encoding @ ~2 ms/sec/call × 100 concurrent calls = ~200 ms/sec sustained = 20% of one core. Modest, but the FS box should not encode.
- Single-pass live encoding is more crash-prone (mid-file truncation produces invalid MP3); WAV truncation just gives a shorter playable file.
- **Decision: WAV from FS, MP3 transcode in R02 worker post-upload (or skip MP3 entirely if we go directly to OPUS-in-OGG via ffmpeg → S3 Glacier-friendly for long-term).**

### 4.4 Bitrates (for capacity planning, §6)

| Format | Channels | Sample rate | Bytes/sec | Bytes/min | Bytes/hr |
|---|---|---|---|---|---|
| WAV PCM s16le | 1 (mono) | 8000 | 16,000 | 960,000 (~960 KB) | ~57.6 MB |
| WAV PCM s16le | 2 (stereo) | 8000 | 32,000 | 1,920,000 (~1.92 MB) | ~115 MB |
| WAV PCM s16le | 1 (mono) | 16000 | 32,000 | 1,920,000 | ~115 MB |
| WAV PCM s16le | 2 (stereo) | 16000 | 64,000 | 3,840,000 | ~230 MB |
| MP3 64 kbps mono | 1 | 8/16 kHz | 8,000 | 480,000 | ~28.8 MB |

Stereo WAV @ 8 kHz is the steady-state Phase 1 number we plan around: **~32 KB/sec** per active call.

---

## 5. Path layout (matches F03 PLAN §14.2)

```
${recordings_dir}/${tenant_id}/${YYYY}/${MM}/${DD}/${campaign_id}_${lead_id}_${uuid}.wav
```

Concrete example:
```
/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
```

### 5.1 Why this shape

- **`${tenant_id}` first** — multi-tenant from day 1 (SPEC §4.5). A `find /var/lib/freeswitch/recordings/1/` answers "all of tenant 1's recordings" cleanly. Per-tenant disk quotas via XFS project quotas or LVM volumes work.
- **`${YYYY}/${MM}/${DD}` next** — natural directory partitioning for retention sweeps (`find ... -mtime +N -delete` per day). Keeps any single directory under ~50,000 files (a 100-agent center does ~40k recordings/day max).
- **`${campaign_id}_${lead_id}_${uuid}` filename** — three identifiers in increasing uniqueness order. Globbing `SOLAR_Q2_*` pulls a campaign's recordings without opening the file. `${uuid}` is the FreeSWITCH channel UUID, globally unique, and the join key with `call_log.uuid` and `recording_log.uuid`.
- **NO `${start_epoch}`** — F03 PLAN §14.2 dropped it and so does this RESEARCH. The R01.md spec mentions it; PLAN should either drop it or reframe as part of the campaign_id token. Adding epoch creates a two-clocks problem (FS strftime vs the start_epoch we'd separately compute) and has no information not already in the filename.

### 5.2 Channel-var template for `record-template` (for SIP-INFO recording — out of scope but reserved)

F03 PLAN documents `record-template` on the Sofia profile; it's only consulted for SIP-INFO `Record: on` requests, which we do not use in Phase 1 (browser uses our WS control plane, not SIP INFO). Profile-level `record-template` is set anyway for symmetry:

```xml
<param name="record-template" value="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
```

### 5.3 Directory creation

`record_session` creates intermediate directories on its own (mod_sndfile uses `switch_dir_make_recursive`). No need for a pre-create cron. `recordings_dir` itself is the volume mount-point declared in F01's compose; FS init creates `${tenant_id}/...` paths on first use.

### 5.4 File naming collision risk

UUID is 36 chars hex with hyphens; collision probability inside a single tenant's same-day directory is mathematically zero. The `(uuid, start_time)` UNIQUE on `recording_log` (see F02 PLAN §4.26) is belt-and-suspenders.

### 5.5 Vicidial parity

Vicidial uses `YYYYMMDD-HHMMSS_PHONENUMBER_AGENTEXT_CAMPAIGNID.wav` ([ViciStack 2026 guide](https://vicistack.com/blog/vicidial-call-recording/)). We diverge intentionally:
- We use UUID (not phone number) for uniqueness — phone number can recur per lead-day.
- We embed `lead_id` (not phone number) for PII-minimization in filenames; phone number is in DB only.
- We prefix with `tenant_id` — Vicidial is single-tenant; we are multi-tenant from day 1.
- Our naming maps cleanly to Vicidial's `recording_log.filename` column for any future migration tooling.

---

## 6. Disk capacity planning

### 6.1 Per-tenant daily volume

Assumptions per Phase 1 reference tenant:

| Var | Value |
|---|---|
| Concurrent agents | 100 |
| Avg call talk-time | 6 min |
| Calls per agent per workday (8 hr) | ~50 (auto-dial Phase 2; ~25 manual) |
| Bytes/sec stereo WAV @ 8 kHz | 32,000 |
| Bytes per 6-min call | ~11.5 MB |

**Per workday:** 100 agents × 50 calls × 11.5 MB ≈ **57 GB/day per tenant** at Phase-2 auto-dial saturation.

For Phase-1 manual dial (50% throughput, ~25 calls/agent/day):
**~29 GB/day per tenant.**

The 23 GB/day in §1 bullet 6 was a more conservative steady-state including idle hours; the 29-57 GB/day range bounds the planning.

### 6.2 Local disk sizing

R02 deletes files after upload+verify (target latency: 5 minutes). On steady state, the disk holds ~5 minutes' worth of recordings = (57 GB ÷ 24 hr) × (5/60) ≈ **200 MB resident** in the happy path.

The **plan-for** number is the worst case: R02 down for 8 hours during peak.
- 8 hr × 7 GB/hr peak ≈ **56 GB backlog**.
- Round up + headroom for FS logs / system overhead → **200 GB recording scratch volume per FS instance** is the minimum sane size.

Phase 3.5 multi-FS: each FS box has its own 200 GB scratch; R02 worker can be co-located with each FS or run as a fleet pulling from all.

### 6.3 Disk-pressure backstop

When `${recordings_dir}` filesystem usage > 85%:
1. Emit `vici2_recording_disk_pct` gauge → alertmanager pages SRE.
2. Keep recording (don't drop calls) but log warnings.

When > 95%:
1. **STOP STARTING NEW RECORDINGS** — set a campaign-wide flag; new originates skip the `record_session` action.
2. R02 worker emergency-flushes oldest files; alarms loud.
3. **Ongoing recordings continue** — partial-loss is worse than full-loss for compliance.

When 100% (write fails):
- `record_session` returns error; channel continues; `recording_log.lifecycle_state='failed'`; `vici2_recording_failures_total{reason='disk_full'}` increments. Call audio for that one call is lost; agent and customer never notice.

### 6.4 Per-call worst case (long calls / dropped uploads)

A single 1-hour call at stereo WAV 8 kHz = **115 MB**. A 4-hour conference (rare; debt-collection dispute) = **460 MB**. Worth noting: nothing in our pipeline times out a recording at length — `record_session` records until the channel hangs up (or `RECORD_MAX_LEN` is set, which we do NOT set Phase 1; Phase 2 may want a 4-hour ceiling as a defense against runaway recordings consuming disk).

### 6.5 Quotas

XFS project quotas per `tenant_id` directory (`xfs_quota -x -c 'project -s -p /recordings/<tid> <projid>'`) is the cleanest enforcement. Phase 1 single-tenant defers; Phase 4 multi-tenant adds it. Document in F03/HANDOFF.

---

## 7. Trigger logic — when does recording start?

### 7.1 The standard Phase-1 outbound flow

```
1. Dialer originates customer leg via T04, &park() lands it on a parked channel.
2. CHANNEL_ANSWER fires on customer leg (carrier returned 200 OK).
3. T01 sees CHANNEL_ANSWER, dispatches to T03's bridge handler.
4. T03 issues uuid_transfer customer-uuid → conf_<agent_id>.
5. Customer leg lands in customer_into_agent_conf dialplan extension (T03 owns).
6. Inside that extension:
     a. answer  (no-op if already answered)
     b. set RECORD_STEREO=true
     c. set RECORD_MIN_SEC=2
     d. set recording_follow_transfer=true
     e. [if state ∈ TWO_PARTY_STATES per C02] play_and_get_digits consent prompt
        - on '1' (consent): proceed to (f)
        - on '2' (decline): per campaign.opt_out_action, hangup OR proceed without record_session
     f. record_session ${path}    ← RECORDING STARTS HERE
     g. conference conf_<agent_id>@default
7. RECORD_START event fires, T01 captures, dialer writes recording_log row (state='recording').
8. CHANNEL_HANGUP fires on customer leg eventually.
9. RECORD_STOP event fires, T01 captures, dialer updates recording_log row (state='completed', duration, size, codec).
10. R02 picks up via Redis stream, uploads to S3, deletes local file, sets recordings.lifecycle_state='available'.
```

### 7.2 Why AFTER consent prompt (not before)

If recording starts before the consent prompt, the consent IVR audio gets recorded (which is mostly fine, except: in two-party-consent states, recording starts before consent is obtained — which is precisely what the law forbids). The cleanest legal posture is:
- In one-party states: recording can start immediately on answer (no consent prompt at all → step 6e is skipped).
- In two-party states: recording starts ONLY after consent is captured (i.e., after step 6e returns "consent given").

C02 is the consent module; R01 cooperates by deferring the `record_session` action until after C02's branch.

### 7.3 Why AFTER answer (not before bridge attempt)

`record_session` before answer would write silence (no media). `RECORD_MIN_SEC=2` deletes files shorter than 2 seconds, but we'd still be doing the I/O. Triggering on `CHANNEL_ANSWER` is the canonical pattern.

There's also `media_bug_answer_req=true` channel var that delays ALL media bugs until the channel is answered — useful as defense-in-depth. **Set it.**

### 7.4 Why the customer leg, not the agent leg

The agent is permanent in their conference; many customer calls flow through that conference over the agent's shift. Recording on the agent leg would produce one long file per agent shift containing all their calls, with no per-call boundaries — useless for QA per-call review. Recording on the customer leg gives one file per call.

### 7.5 Recording on inbound (I01 in-groups, Phase 3)

Same primitive: `customer_into_ingroup` dialplan extension sets the same vars + `record_session`. Inbound differs only in trigger: recording starts when the call enters the in-group queue OR when bridged to an agent (campaign-mode-equivalent setting). I01 will own its half; R01 stays format-agnostic.

### 7.6 State recording mode interactions

| `campaigns.recording_mode` | Behavior in T03 dialplan |
|---|---|
| `NEVER` | `record_session` is conditional on this; skip the action. |
| `ONDEMAND` | Skip `record_session` in dialplan; agent UI POSTs `/api/agent/recording {action:'start'}` mid-call → dialer issues `bgapi uuid_record <uuid> start <path>`. |
| `ALL` | Dialplan executes `record_session`; agent CAN pause/resume via `/api/agent/recording {action:'pause'|'resume'}` (mask/unmask). |
| `ALLFORCE` | Dialplan executes `record_session`; agent **CANNOT** pause/resume (API returns 403 per DESIGN §5 line 710). |

### 7.7 Recording beep tones (jurisdiction-specific)

Some jurisdictions (Germany BDSG, France CNIL, parts of UK FCA-regulated trading) require an audible beep ~every 15 seconds during recording. Phase 1 USA-only; **deferred to C02 Phase 2** which would inject a `displace_session beep.wav loop` parallel to record_session. R01 reserves the var name `vici2_recording_beep=true|false` and documents the seam.

---

## 8. Pause / resume for PCI

### 8.1 The technique: `uuid_record <uuid> mask | unmask <path>`

Mask substitutes silence into the recording without stopping the underlying media bug. Unmask resumes the live audio. The recording file remains a single continuous WAV — listeners hear silence during the masked period instead of hearing the conversation. ([uuid_record reference](https://www.freeswitch.org.cn/books/references/2.40-uuid_record.html))

### 8.2 Why mask, not stop+restart

- **`stop_record_session` + `record_session` with `RECORD_APPEND=true` is broken in many FS versions** — Igor Olkhovskyi reported distorted audio on resume in 1.6.18 ([2017 list](http://lists.freeswitch.org/pipermail/freeswitch-users/2017-June/126642.html)). His own resolution was to switch to mask/unmask. FreeSWITCH 1.10.x has not been re-validated to fix it.
- mask/unmask preserves a **single file** (one row in `recording_log`) — semantically simpler.
- FusionPBX, NEventSocket, and production callers all use mask/unmask (see GitHub citations §12).
- The UI seam is dead simple: agent presses Pause → `POST /api/agent/recording {action:'pause'}` → dialer → `bgapi uuid_record <uuid> mask <path>`. Resume is `unmask`.

### 8.3 Go API (lives in `dialer/internal/recording/`)

```go
package recording

type Recorder interface {
    // StartRecording is the ONDEMAND entry point. Path is computed by template.
    StartRecording(ctx context.Context, callUUID string, m Metadata) (path string, err error)

    // StopRecording forces a stop (supervisor override / kill-switch).
    StopRecording(ctx context.Context, callUUID string) error

    // PauseRecording masks the recording with silence (PCI use case).
    PauseRecording(ctx context.Context, callUUID string) error

    // ResumeRecording unmasks (audio captured normally again).
    ResumeRecording(ctx context.Context, callUUID string) error
}

type Metadata struct {
    TenantID   int64
    CampaignID string
    LeadID     int64
    AgentID    int64  // 0 if not assigned
    StartedAt  time.Time
}
```

Internally each method is one `bgapi` call via the T01 ESL client:
- Start: `bgapi uuid_record <uuid> start <path>`
- Stop: `bgapi uuid_record <uuid> stop <path>`
- Pause: `bgapi uuid_record <uuid> mask <path>`
- Resume: `bgapi uuid_record <uuid> unmask <path>`

The `<path>` argument MUST match the active recording's path for mask/unmask to find the right bug — we read it from `calls:active:{uuid}` Redis hash, which T03 wrote at `record_session` time.

### 8.4 PCI DSS 4.0.1 (effective 2024-12, fully mandatory 2025-04-01) **superseding caveat**

The PCI Security Standards Council and major QSA practitioners (Eckoh, SecurePII, Genesys) now treat **manual pause/resume as obsolete** for PCI scope reduction:

- Eckoh ([Dec 2024 blog](https://www.eckoh.com/blog/is-pause-and-resume-dead-yes-if-you-want-to-comply-with-pci-dss-v4-0-1)): "Pause and resume can fail. When it does, cardholder data could end up in the wrong place — an unintended channel or system that's not properly secured. … the system is now in scope for PCI DSS."
- SecurePII ([Mar 2025 paper](https://www.securepii.cloud/card-payments-over-the-phone/)): "Pause-and-resume" is "no longer satisfactory" — agents forget; insider abuse; post-call redaction is too late.
- PCI SSC Protecting Telephone-Based Payment Card Data ([PDF](https://www.pcisecuritystandards.org/documents/protecting_telephone-based_payment_card_data.pdf)): **CVV2/CVC2/CVV2/CID codes can NEVER be stored in any digital audio format**, even encrypted. Recording any leg during card capture creates a violation regardless of pause-and-resume reliability.

**What this means for vici2:**

1. R01 ships the mask/unmask primitive (it's table stakes; we'd be conspicuous without it).
2. R01 **does NOT** market this as PCI-compliant. Documentation must say: "mask/unmask reduces but does not eliminate exposure; use a PCI-DSS-certified payment IVR or DTMF-suppression sidecar (e.g., PCI Pal, Eckoh, Semafone, Aeriandi) for actual payment processing in Phase 2+."
3. The seam for the Phase-2 sidecar is the same `recording_consent_audio`/`record_session` dialplan branch — a payment IVR overlays the path.
4. We document this prominently in HANDOFF + the admin UI's pause-button tooltip.

### 8.5 Audit trail per pause/resume event

Every Pause/Resume invocation writes one row to `audit_log`:
```
{
  ts, tenant_id, user_id (agent),
  entity_type='recording', entity_id (recording_log.id),
  action='pause'|'resume',
  metadata: {call_uuid, path}
}
```
C03 (Audit log immutability) consumes; M08 reports surface "% of calls paused" by agent for QA.

### 8.6 Agent vs supervisor permissions on pause/resume

- `recording_mode='ONDEMAND'`: agent can start/stop.
- `recording_mode='ALL'`: agent can pause/resume; cannot fully stop.
- `recording_mode='ALLFORCE'`: agent CANNOT pause/resume; supervisor CAN (with elevated role + extra audit weight).

Enforced in API layer (auth check before ESL command).

---

## 9. Failure handling

### 9.1 Failure modes

| Failure | Cause | Detection | Action |
|---|---|---|---|
| Disk full | All scratch space consumed | `record_session` returns -ERR; `RECORD_STOP` event has empty Path or Record-Ms=0 | log error, increment `vici2_recording_failures_total{reason='disk_full'}`, write `recording_log.lifecycle_state='failed'`, **call continues normally** |
| Permission denied | volume mount perms wrong | Same as above | Same as above; alert SRE — likely deploy bug |
| File path not creatable | Tenant_id missing, var unresolved | `record_session` returns -ERR | Same; log specifically as `reason='path_unresolved'` so we can find dialplan bugs |
| Codec mismatch | Source codec FS can't read | media bug attached but no audio captured; resulting WAV is silence or 0 bytes | `RECORD_MIN_SEC=2` filters; bug report |
| FS process crash mid-recording | OOM, segfault | RECORD_STOP never fires; partial WAV on disk | T01's reconcile-on-reconnect (T01 RESEARCH §8.5) finds orphan files; janitor (E06) reaps after grace period; `recording_log.lifecycle_state='orphan'` set by reconciler |
| R02 worker down → disk fills | Backlog of un-uploaded files | disk pressure metric (§6.3) | At 85% warn, 95% stop new recordings, 100% recording fails (call OK) |
| Network partition: dialer → ESL | Mask/unmask command never reaches FS | bgapi returns timeout / no BACKGROUND_JOB | API returns 503 to agent UI; agent re-tries; pause was a no-op; safer than risk of half-state |

### 9.2 The "should we hang up the call?" question

**No.** Recording failure does not justify ending a call.
- Customer paid attention, may be ready to buy → losing the sale is a real revenue cost.
- Compliance: TCPA does not require recording (recording is for QA/training/dispute resolution); FTSA, etc. require **disclosure**, not capture.
- The exception: if `campaigns.recording_required=true` AND the failure is detected mid-call (rare; usually we'd know at start), API may signal agent "recording broken; please end call gracefully" via a soft warning, but the system does NOT auto-hangup.

### 9.3 Failed recordings still get a `recording_log` row

For audit completeness, write a row with:
```
{
  ...
  filename: <intended path>,
  storage_url: NULL,
  duration_sec: 0,
  size_bytes: 0,
  lifecycle_state: 'failed',
  failure_reason: 'disk_full' | 'permission_denied' | 'path_unresolved' | ...
}
```

R03 playback UI shows "Recording unavailable — failed" for these; never returns 404.

### 9.4 RECORD_STOP event hygiene

`RECORD_STOP` event headers we capture (per Stack Overflow [46096030](https://stackoverflow.com/questions/46096030/record-startstop-event-in-freeswitch-esl) + [list 2011](https://lists.freeswitch.org/pipermail/freeswitch-users/2011-June/073950.html)):
- `Record-File-Path` — full file path
- `Record-Ms` — duration in ms (also exposed as `record_ms` channel var)
- `Record-Read-Sample-Rate` — Hz, e.g. 8000
- `variable_uuid`, `variable_lead_id`, `variable_campaign_id`, `variable_tenant_id`, `variable_user_id` — our enrichment vars
- `variable_record_samples` — total samples written

`size_bytes` is NOT in the event; we `os.Stat()` the file in R02 (or in the dialer's RECORD_STOP handler) to populate the `recording_log` row. Defer to R02 since R02 owns the disk-touch lifecycle.

### 9.5 Metrics surface

| Metric | Type | Labels |
|---|---|---|
| `vici2_recording_started_total` | counter | `tenant_id`, `campaign_id`, `mode` (auto\|ondemand) |
| `vici2_recording_completed_total` | counter | `tenant_id`, `campaign_id` |
| `vici2_recording_failures_total` | counter | `tenant_id`, `reason` (disk_full\|permission_denied\|path_unresolved\|codec\|orphan) |
| `vici2_recording_duration_seconds` | histogram | `tenant_id`, `campaign_id` |
| `vici2_recording_disk_pct` | gauge | `fs_host` |
| `vici2_recording_active_count` | gauge | `tenant_id` |
| `vici2_recording_pause_total` | counter | `tenant_id`, `actor_role` (agent\|supervisor) |
| `vici2_recording_resume_total` | counter | `tenant_id`, `actor_role` |

---

## 10. Hand-off to R02 and C02

### 10.1 To R02 (S3 upload worker)

R02 consumes:
- **Redis Stream `vici2.call.record_stop`** — produced by T01's RECORD_STOP fan-out (T01 RESEARCH §7.2). Each event carries:
  ```json
  {
    "uuid": "<channel_uuid>",
    "tenant_id": 1,
    "campaign_id": "SOLAR_Q2",
    "lead_id": 4287,
    "user_id": 901,
    "filename": "/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_<uuid>.wav",
    "duration_ms": 312500,
    "sample_rate": 8000,
    "channels": 2,
    "fs_host": "fs1"
  }
  ```
- **`recording_log` row** is written by R01 (via the dialer worker handling RECORD_STOP) BEFORE R02 sees the event — R02 looks up the row by `(uuid, start_time)` and updates it.

R02 produces:
- `recordings.lifecycle_state` transitions: `encoding` → `available` (or `failed`) — see F02 PLAN §4.18.
- `recording_log.storage_url` populated with `s3://bucket/<path>`.
- Local file deletion after S3 PUT + checksum verify.
- Updates `recording_log.size_bytes` and `recording_log.encoded_at`.

R01 does NOT delete local files. R01 does NOT touch S3. Clear separation.

### 10.2 To C02 (consent gating)

R01 inspects `consent_status` channel-var written by C02 BEFORE deciding whether to invoke `record_session`:
- `consent_status=not_required` (one-party state) → `record_session` runs immediately on bridge.
- `consent_status=prompted_accepted` → `record_session` runs after C02's prompt completes.
- `consent_status=prompted_declined` → `record_session` does NOT run; campaign's `opt_out_action` decides hangup vs continue without record.
- `consent_status=assumed` (lead state unknown; default-restrictive per C02) → treat as `prompted_accepted` only if C02 actually played the prompt, else as `prompted_declined`.

The `consent_status` value is also written verbatim to `recording_log.consent_status` (per F02 PLAN §4.26 — the column is reserved for C02 to populate), giving us a per-recording proof of the consent pathway.

### 10.3 To T03 (agent-conference dialplan) — how to wire `record_session`

T03's `customer_into_agent_conf` extension MUST include the recording action AFTER consent and BEFORE the `conference` join:

```xml
<extension name="customer_into_agent_conf">
  <condition field="destination_number" expression="^conf_(\d+)$">
    <action application="answer"/>
    <action application="set" data="media_bug_answer_req=true"/>
    <action application="set" data="RECORD_STEREO=true"/>
    <action application="set" data="RECORD_MIN_SEC=2"/>
    <action application="set" data="recording_follow_transfer=true"/>
    <!-- C02 consent gate inline (dispatches based on lead.state) -->
    <action application="execute_extension" data="recording_consent_check XML default"/>
    <!-- record_session executes only if consent_record_enabled is true; recording_consent_check sets it -->
    <action application="execute_extension" data="record_session_if_consented XML default"/>
    <action application="conference" data="agent_$1@default+flags{endconf=false}"/>
    <action application="hangup"/>
  </condition>
</extension>
```

Two referenced sub-extensions (defined under `35_recording_consent.xml` per C02 + a new `30_recording.xml` per R01):

```xml
<extension name="record_session_if_consented">
  <condition field="${consent_record_enabled}" expression="^true$">
    <action application="record_session"
            data="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
  </condition>
</extension>
```

(R01 PLAN finalizes the exact XML; this RESEARCH establishes the contract.)

### 10.4 To T04 (originate primitive)

T04 sets the `RECORD_*` vars and `recording_follow_transfer=true` in the originate channel-var blob, BEFORE `&park()`:

```
{origination_uuid=...,RECORD_STEREO=true,RECORD_MIN_SEC=2,recording_follow_transfer=true,media_bug_answer_req=true,...}sofia/gateway/...
```

This way the vars are present when the customer leg eventually executes the conference-bridge dialplan. T04 PLAN must include this in its var set.

### 10.5 To O01 (observability)

R01 emits the metrics in §9.5; O01's Grafana dashboard "Recording" panel pulls them. Alerts:
- `rate(vici2_recording_failures_total[5m]) > 0.01` per tenant → page (1% failure rate is bad).
- `vici2_recording_disk_pct > 0.85` for 2m → warn.
- `vici2_recording_disk_pct > 0.95` for 30s → page.
- Sudden drop in `rate(vici2_recording_started_total[5m])` while `rate(vici2_call_answered[5m])` is normal → page (recording silently broken).

---

## 11. Open questions for PLAN

1. **Drop `${start_epoch}` from R01.md filename template?** F03 PLAN already did. PLAN must reconcile R01.md to remove it (and update HANDOFF to document the simpler 3-token name).

2. **`record_sample_rate` override or auto?** Recommend NOT overriding (let codec drive); confirm with carrier matrix once T02 lands.

3. **`RECORD_MAX_LEN` ceiling?** Phase 1: no cap (let calls run as long as they want). Phase 2: consider 4-hour cap as runaway-protection. PLAN to decide.

4. **Multi-segment recordings on transfer?** `recording_follow_transfer=true` keeps recording across transfers, so we end up with one continuous file even when ownership changes. Do we want a per-segment marker (RECORD_MARK?) or is one file fine? Recommend: one file (simpler), with `audit_log` rows marking transfer events for QA.

5. **How does R01 cooperate with `recording_required=true`** when the consent prompt declines? PLAN must define the `opt_out_action` semantics: `hangup_call` vs `proceed_without_recording`. C02 PLAN might be the right home, but R01 needs the contract.

6. **Mid-call mode change?** Can a supervisor flip `campaigns.recording_mode` from ALL → NEVER mid-call and stop ongoing recordings? Recommend: NO. Mode applies at call-start. Supervisor can issue a one-off `StopRecording(uuid)` for a specific call; bulk mode change applies to NEW calls only.

7. **Encryption-at-rest on the local scratch volume?** LUKS / dm-crypt on the recordings volume is cheap and material for HIPAA-adjacent workloads. Recommend: defer to F03/O05 (security baseline) but note it.

8. **`vici2_recording_beep` interval / file**: Phase 1 does not ship beep tones. PLAN reserves the channel-var name and notes the seam (probably `displace_session beep.wav loop`).

9. **Does R01 need its own dialer-side worker process, or does the existing T01 ESL bridge suffice?** Recommend: T01 fan-out + a small recording-event consumer in the dialer that owns the `recording_log` insert/update on RECORD_START/RECORD_STOP. No separate process.

10. **R02 deletion race**: if R02 deletes the file while R03 (playback) is mid-stream serving it, the file handle stays open on Linux (mmap'd) until R03 closes — we're OK with POSIX semantics. But if we shift to NFS or S3-backed local cache, behavior differs. Document for R03 PLAN.

11. **Stereo vs single-channel toggle per tenant?** Some tenants may not want stereo (privacy / storage cost). Recommend: `tenants.recording_stereo BOOLEAN DEFAULT TRUE`. PLAN to add column.

12. **Recording integrity / tamper-evidence?** SHA-256 the WAV at RECORD_STOP and store in `recording_log.checksum`; R02 verifies post-upload. Phase 1 nice-to-have, Phase 2 (legal hold) required. PLAN to decide phase.

13. **Verifying `RECORD_MIN_SEC` actually deletes short files**: cited [2011 list](https://lists.freeswitch.org/pipermail/freeswitch-users/2011-July/074861.html) suggests `RECORD_MIN_SEC` only takes effect with `media_bug_answer_req` or `record_session`. Since we use both, it should work — VERIFY phase tests it explicitly.

---

## 12. Citations

1. FreeSWITCH — `mod_dptools record_session` reference (SignalWire docs, current canonical): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod-dptools/6587110/
2. FreeSWITCH — `uuid_record` reference (start/stop/mask/unmask, limit param): https://www.freeswitch.org.cn/books/references/2.40-uuid_record.html
3. FreeSWITCH — `RECORD_STEREO` channel var: https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/RECORD_STEREO_16352883/
4. FreeSWITCH — `RECORD_STEREO_SWAP` channel var (invert L/R): https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/RECORD_STEREO_SWAP_16353895/
5. FreeSWITCH — `RECORD_MIN_SEC` channel var (deletes short recordings): https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/RECORD_MIN_SEC_16353882/
6. FreeSWITCH — `recording_follow_transfer` channel var: https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/recording_follow_transfer_16352908/
7. FreeSWITCH — `record_ms` channel var (duration written by RECORD_STOP): https://developer.signalwire.com/freeswitch/Channel-Variables-Catalog/record_ms_16353885
8. FreeSWITCH — Brian West confirmation: stereo per-leg via `record_session` is recommended ([2016 freeswitch-users](http://lists.freeswitch.org/pipermail/freeswitch-users/2016-April/119856.html))
9. FreeSWITCH — `record_session` vs `uuid_record` vs conference-record equivalence (Brian West [2008 freeswitch-users](http://lists.freeswitch.org/pipermail/freeswitch-users/2008-October/035088.html))
10. FreeSWITCH — Anthony Minessale: `RECORD_WRITE_ONLY` per-leg alternative ([2013 freeswitch-users](https://lists.freeswitch.org/pipermail/freeswitch-users/2013-July/098119.html))
11. FreeSWITCH — `RECORD_STEREO` broken in conference: [signalwire/freeswitch#895](https://github.com/signalwire/freeswitch/issues/895), reproduced 2018+2020 ([2020 freeswitch-users](http://lists.freeswitch.org/pipermail/freeswitch-users/2020-October/134073.html))
12. FreeSWITCH — Anthony Minessale: stereo only works in conferences via openal positioning, not standard `RECORD_STEREO` ([2017 freeswitch-users](https://lists.freeswitch.org/pipermail/freeswitch-users/2017-April/125589.html))
13. FreeSWITCH — `recording_follow_transfer` documentation in mod_dptools record_session page (continue across transfer): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod-dptools/6587110/
14. FreeSWITCH — `RECORD_STOP` event sample headers ([2011 freeswitch-users](https://lists.freeswitch.org/pipermail/freeswitch-users/2011-June/073950.html)) and Stack Overflow [46096030](https://stackoverflow.com/questions/46096030/record-startstop-event-in-freeswitch-esl) (conference recording does NOT emit standard RECORD_*)
15. FreeSWITCH — recording-on-transfer Lua/post-bridge pattern ([2016 freeswitch-users](http://lists.freeswitch.org/pipermail/freeswitch-users/2016-October/123364.html))
16. FreeSWITCH — `stop_record_session` + `RECORD_APPEND` distortion bug (Igor Olkhovskyi, [2017 freeswitch-users](http://lists.freeswitch.org/pipermail/freeswitch-users/2017-June/126642.html)) — workaround: switch to mask/unmask
17. FreeSWITCH — pause/resume via mask/unmask in production (Provoip blog 2017): https://blog.provoip.org/2017/06/
18. FusionPBX — feature add mask/unmask recordings in real time for PCI compliance (PR #5373, 2020): https://github.com/fusionpbx/fusionpbx/pull/5373
19. NEventSocket (production .NET ESL client) — uuid_record mask usage example: https://github.com/danbarua/NEventSocket/blob/master/src/NEventSocket/Channels/BasicChannel.cs#L502
20. NEventSocket — DTMF-triggered uuid_record mask + displace_session for "recording paused" prompt: https://github.com/danbarua/NEventSocket/blob/master/src/NEventSocket.Examples/Examples/InboundSocketExample.cs#L139
21. PCI Security Standards Council — Protecting Telephone-Based Payment Card Data (CVV2/CVC2/CID never storable in audio): https://www.pcisecuritystandards.org/documents/protecting_telephone-based_payment_card_data.pdf
22. Eckoh — *Pause and resume of call recordings is obsolete* (PCI DSS v4.0.1 analysis, Dec 2024): https://www.eckoh.com/blog/pause-and-resume-of-call-recordings-is-obsolete-exploring-pci-dss-4-0-1-and-its-impact-on-data-security-practices
23. Eckoh — *Is Pause and Resume Dead?* (Dec 2024): https://www.eckoh.com/blog/is-pause-and-resume-dead-yes-if-you-want-to-comply-with-pci-dss-v4-0-1
24. SecurePII — *Insight Report: PCI DSS v4.0 Mandatory From April 1st 2025* (Mar 2025): https://www.securepii.cloud/card-payments-over-the-phone/
25. Genesys — *4-1-1 on Updated PCI-DSS Guidance for Contact Centers* (DTMF masking is the supported descope path): https://genesys.com/blog/post/get-the-4-1-1-on-updated-pci-dss-guidance-for-contact-centers
26. Paytia — *PCI DSS Compliance for Contact Centres: The 2026 Guide* (PCI DSS 4.0 mandatory 2025-04-01): https://www.paytia.com/resources/blog/pci-dss-4-0-call-centre-guide
27. RecordingLaw.com — *Two-Party Consent States for Recording (2026 Guide)* (13-state list, statutory citations, civil + criminal penalties): https://www.recordinglaw.com/party-two-party-consent-states
28. RecordingLaw.com — *Is It Illegal to Record Someone? US Recording Laws Explained (2026)* (13 all-party-consent states, NY S5077 pending): https://www.recordinglaw.com/us-laws/is-it-illegal-to-record-someone
29. JustCall — *Call Recording Laws by State: 2026 Compliance Guide* (state-by-state matrix): https://justcall.io/blog/customer-service-call-recording-laws-all-you-need-to-know.html
30. Rev — *Phone Call Recording Laws: What You Need to Know (2025)* (one-party vs all-party state lists, interstate-call doctrine): https://rev.com/blog/phone-call-recording-laws-state
31. LeadCompliant — *State Recording Consent Requirements Matrix* (2026, telemarketing-specific intersection with TCPA/TSR): https://leadcompliant.com/forms/call-recording/state-recording-consent-requirements-matrix
32. Digital Media Law Project — *Recording Phone Calls and Conversations* (federal 18 U.S.C. 2511 baseline; interstate uncertainty): http://dmlp.org/legal-guide/recording-phone-calls-and-conversations
33. ViciStack — *VICIdial Call Recording: Storage, Compliance & Archival (2026)* (MixMonitor naming convention parity reference): https://vicistack.com/blog/vicidial-call-recording/
34. ViciStack — *VICIdial Quality Assurance Scoring with Call Recordings* (MixMon vs Monitor mode trade-offs): https://vicistack.com/blog/vicidial-qa-scoring
35. Vicidial.org forum — *Naming convention of the Call Recording File Name* (Vicidial filename token vocabulary): https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=36035
36. O'Reilly *Mastering FreeSWITCH* (2016) — call recording chapter (single stereo file as elegant solution): https://www.oreilly.com/library/view/mastering-freeswitch/9781784398880/ch05s04.html

---

**End of R01 RESEARCH.md.** Next stop: R01 PLAN (blocked on T03 PLAN, T04 PLAN, F02 PLAN approval; C02 contract for `consent_status` channel var; R02 contract for Redis stream + `recording_log` row hand-off).

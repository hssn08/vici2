# E05 — Drop-Rate Enforcement + Safe-Harbor (FCC 3% Gate) — RESEARCH

| Field | Value |
|---|---|
| Module | E05 (drop-gate; per-campaign 30-day rolling abandonment-rate tracker + safe-harbor enforcer) |
| Phase | 2 (auto-dialer) |
| Owner agent type | backend-go + telephony (one Go goroutine + one FreeSWITCH dialplan extension + one Node ESL handler) |
| Status | RESEARCH (PLAN blocked on: a one-paragraph E02 PLAN ratification of the `drop_gated` STRING contract; F02 amendment for `campaigns.drop_target_soft` + `campaigns.recover_seconds` + `campaigns.drop_target_max_override` — see §16) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/E05.md` (4 KB skeleton: tracks abandonment per campaign per 30-day rolling window; plays safe-harbor on no-agent-within-2 s; throttles E02 to PROGRESSIVE when over target; writes `drop_log`; per-campaign target). This RESEARCH supersedes the spec wherever they collide and pins (a) the soft-cap-at-2.5%/hard-cap-at-3% threshold pair, (b) the dual-write Valkey-stream-plus-MySQL-row authoritativeness contract, (c) the FCC § 64.1200(a)(7)(ii) denominator definition. |
| Related plans read | E02 RESEARCH §3.4 / §4.4 / §12.1–§12.2 (drop_gated clamp shape; gauge key; FCC hooks); E02 PLAN §10 row 10 / §11 (drop_gated transition discipline); T04 PLAN §3.2 (drop-cap gate as the originate-time companion of E05's pacing-time gate); D04 RESEARCH §3 (DROP/PDROP/ERI/AMD status flag semantics; `humanAnswered` denominator column); F04 PLAN §4.3 / §5.1 / §6.3 (`drop_window` STREAM definition + `record_call_outcome.v1.lua` writer); F02 schema (`call_log.is_drop`, `drop_log` partitioned table, `campaigns.adaptive_drop_pct`, `campaigns.safe_harbor_audio`); T04 RESEARCH §10 (drop-cap gate semantics) |

---

## 1. Executive summary (10 bullets)

1. **E05 is the per-campaign drop-rate tracker + the safe-harbor terminator + the originate-time drop-gate authority.** It owns three loci: (a) the **answer-side terminator** — when a customer-answered call reaches the "no agent within 2 seconds of greeting" deadline, E05 plays the safe-harbor audio and writes the abandon row; (b) the **rolling-window calculator** — every 15 s, E05 reads F04's `drop_window` STREAM and recomputes the per-campaign 30-day denominator / numerator and publishes a `drop_pct` gauge; (c) the **gate publisher** — E05 writes a Boolean `drop_gated` Valkey STRING that E02's clamp #3 (E02 RESEARCH §3.4) reads at every 1-Hz pacing tick. E05 does **not** originate (E02/T04 do), does **not** pick agents (E04 does), does **not** read leads (E01 does), does **not** maintain the agent ZSETs (F04 does), and does **not** publish the dial_level (E03 does). E05 also does **not** compute the originate-time drop-cap gate's verdict synchronously — T04's `gateDropCap` re-reads the same `drop_pct` gauge (T04 PLAN §3.2 — gate is "Phase 1 stub ALLOW; E03/E05 wire later"; this PLAN ratifies "E05 wires it") — but E05 is the only writer of the gauge. Surface: ~400 LOC Go + ~200 LOC tests + 1 FreeSWITCH dialplan extension + 1 Node ESL handler in api/src/esl/.

2. **Soft cap = 2.5%, hard cap = 3.0%, default-on at 2.0% recommended.** The FCC hard floor is **3.0%** per 47 CFR § 64.1200(a)(7) — "such telemarketer abandons no more than three percent of all telemarketing calls that are answered live by a person, measured over a 30-day period for a single calling campaign." Industry practice (DNC.com [4], SIPNEX [6], DESIGN.md §1.2 key-knobs line "adaptive_dropped_percentage default 3.0; recommend 1.5") is to ship at 1.5–2.0% to leave 1.0–1.5 percentage-point safety margin against measurement error + clock skew + denominator-vs-numerator atomicity gaps (§5.7). Our scheme is a **two-tier ceiling**: (i) **soft cap** at 2.5% (75% of hard cap) → page operator + stop E03 dial-level increases (E03 reads `drop_pct` directly per its own RESEARCH; E05 does not call E03); (ii) **hard cap** at 3.0% (FCC ceiling) → set `drop_gated=1`, which clamps E02 to `desired=1` (effectively PROGRESSIVE). Per-campaign override columns: `campaigns.adaptive_drop_pct` (already in F02 schema; default 1.50; we propose **renaming to `drop_target_max` in F02 amendment** to disambiguate from E03's dial-level adapt target — see §16) PLUS new amendment columns `drop_target_soft` (default 2.50) and `recover_seconds` (default 300, the minimum dwell time before the gate releases — prevents flapping). Operator-facing: M03 admin UI exposes both numbers + a "live drop %" gauge.

3. **The "called party abandonment" definition is a four-clause predicate.** Per FCC 47 CFR § 64.1200(a)(7) [cite 1] + FTC TSR 16 CFR § 310.4(b)(4)(i) [cite 7]: a call is **abandoned** if and only if **all four** of these are true: (i) the call **is answered by a live human** (not an answering machine, not a fax, not a busy/ring-no-answer, not a SIT tone); (ii) **no live sales representative connects** to the called person; (iii) the failure to connect happens **within 2 seconds** of the called person's completed greeting; (iv) the seller cannot establish, via the "safe-harbor" recorded-message exception, that fewer than 3% of all live-answered calls in the 30-day window were so abandoned. Note: an abandoned call IS still counted in the denominator (it's a live-answered call) AND it's counted in the numerator (it's an abandoned call). The only way a "no agent within 2 s" event is **not** an abandon is the **safe-harbor exception** (§3) — a properly-formed recorded message plays inside the 2-second window, with seller name + callback number + opt-out, AND fewer than 3% of live-answers in the window receive that recording. Our schema therefore distinguishes:
   - `DROP` (D04 status, `is_drop=true`) — abandoned per FCC definition, COUNTS toward numerator
   - `PDROP` (D04 status, `is_drop=true` but `safe_harbor_played=true`) — pre-route drop — answered+no-agent + safe-harbor recording played + still counts toward numerator (because the safe-harbor exception is a 3% LIMIT on this number, not a way to make these calls disappear from the count — see §3.3 for the legal subtlety)
   - `human_answered=true` for both — both count in the denominator

4. **Schema decision: dual-write (Valkey-stream-authoritative-fast-path + MySQL-row-authoritative-evidence).** The `drop_log` table (F02 schema §4.27, partitioned by `dropped_at`) is the **TCPA-evidence** source of truth; `call_log.is_drop=true` is the **reporting** source of truth; the Valkey `drop_window` STREAM (F04 PLAN §4.3) is the **fast-path 1-Hz read** source. Three writers must agree:
   - **Numerator** (drops in last 30 d): authoritatively `SELECT COUNT(*) FROM drop_log WHERE tenant_id=? AND campaign_id=? AND dropped_at >= NOW() - INTERVAL 30 DAY`. Cached in Valkey `t:{tid}:campaign:{cid}:drop_count_30d` STRING (15 s TTL via E05 ticker).
   - **Denominator** (live-answered calls in last 30 d): authoritatively `SELECT COUNT(*) FROM call_log c JOIN statuses s ON c.tenant_id=s.tenant_id AND c.status=s.status WHERE c.tenant_id=? AND c.campaign_id=? AND c.call_started >= NOW() - INTERVAL 30 DAY AND s.human_answered=TRUE`. Cached likewise.
   - **Fast path** (E03 + S01 wallboard 1-Hz reads): Valkey `drop_window` STREAM — entries are `{answered: 0|1, dropped: 0|1, ts, call_uuid}` written by T01's `record_call_outcome.v1.lua` (F04 PLAN §6.3). XLEN of "answered=1" entries = denominator estimate; XLEN of "dropped=1" entries = numerator estimate. Reconciler cron at 60 s drift checks MySQL vs Valkey within 0.05% tolerance — if drift exceeds, E05 alerts + falls back to MySQL.
   The dual-write is **not optional** — TCPA litigation discovery requires durable MySQL evidence (cite [9] Litigator Risk Solutions; cite [10] TCPAWorld 2021 article) AND the 1-Hz E02 hot path requires sub-ms reads (Valkey).

5. **Eight numerator edge cases worth committing to explicit handling.** (i) **AMD-classified-but-actually-human (false-positive AMD)**: per D04's `A`/`AA`/`AVMA` statuses with `human_answered=false`, these are excluded from BOTH numerator and denominator. **Risk**: false-positive AMD hides drops from the FCC count — operator should be alerted if AMD rate > 25% (an outlier that suggests the AMD detector is mis-classifying live humans). (ii) **Human-who-hangs-up-before-2 s**: AMBIGUOUS in case law (DNC.com [4] interprets generously: "if the customer terminated before our 2-second window expired, it's NOT an abandon"; conservative interpretation [9] says "any answered-then-disconnected within 2 s counts"). Our default: **count as abandoned** (conservative; defensible in litigation) BUT log `drop_reason='customer_hangup_early'` so reporting can show both numbers. Per-campaign override `campaigns.count_early_customer_hangup_as_drop` (default `true` — conservative — F02 amendment §16). (iii) **Answered-then-bridged-after-2-seconds**: this IS an abandon by the strict FCC definition (the "2 seconds" is measured to the moment-of-bridge, not the eventual outcome). E04 picker therefore must call `BridgeOrAbandon` which checks the 2-s deadline; this is enforced by the answer-side terminator (§4). (iv) **Answer event but no audio greeting (e.g., dropped immediately)**: still counts — the FCC's "completed greeting" is the customer saying hello; if the customer never speaks, the 2-second clock starts at `CHANNEL_ANSWER` per [11]. (v) **Fax-detected-then-human**: rare; AMD says fax, then real audio appears; counts as human_answered (status `A`-corrected at agent dispo) — these flow through MANUAL only in Phase 1, no AMD in Phase 1, so not a real problem yet. (vi) **Bridged but agent never said hello**: still counted as BRIDGED (denominator yes, numerator no) — the FCC rule is about agent **connection**, not agent **speech**. (vii) **Network-disconnect-mid-greeting**: depends on whether `CHANNEL_ANSWER` had fired; if yes, count as human_answered + abandoned (the customer answered, we lost them). (viii) **Pre-route drops** (`PDROP` — channel dropped between answer signal and dialer's "we have a call" handler): COUNT (FCC doesn't care that our software was slow to react). See §6 for the implementation per case.

6. **The denominator is `count(human_answered=true)`, not `count(*)`.** Per D04 RESEARCH §3.3 and §10, the `humanAnswered` flag on D04's `statuses` table is the **single authoritative** column for FCC denominator membership. Statuses in the denominator (`human_answered=true`): `INCALL`, `SALE`, `NI`, `NP`, `CALLBK`, `DNC`, `XFER`, `DEC`, `WRONG`, `DEAD`, `DROP`, `PDROP`, `ERI`. Statuses NOT in the denominator: all `system-amd` (`A`, `AA`, `AVMA`, `AFAX`) — answering machine isn't a person; all `system-carrier` (`B`, `B-CAR`, `NA`, `NA-CAR`, `ADC`, `INVALID`, `TIMEOT`, `MEDIA_TO`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`) — never answered by a person; `system-compliance` (`TCPA`, `CONSENT_NOT_OBTAINED`) — pre-dial, never answered; `lifecycle` (`NEW`, `QUEUE`, `CBHOLD`) — no answer event. Status `LM` (left voicemail) is `human_answered=false` because Vicidial-forum convention [13] treats VM as a machine pickup (even though a person ostensibly answered to record the greeting); this matches FTC TSR guidance [3]. Critical invariant: the denominator is computed **exactly once** by joining `call_log` to `statuses` and reading `human_answered`, never reconstructed from a `status IN ('A','B','NA',...)` list (which is the #1 source of TCPA-reporting drift in Vicidial-land per [5][13]).

7. **Per-campaign isolation is absolute.** A campaign-A drop never affects campaign-B's pacing. The Valkey key namespace is `t:{tid}:campaign:{{cid}}:drop_*` (hash-tagged so per-campaign keys colocate on one Cluster shard — F04 PLAN §4.7); the MySQL `drop_log` table is indexed `(tenant_id, campaign_id, dropped_at)` (schema §4.27). E05's recompute ticker iterates active campaigns one-at-a-time; the `drop_gated` STRING is per-`{cid}`. Cross-campaign isolation is the FCC's bright line: 47 CFR § 64.1200(a)(7) reads "for a single calling campaign" — the FCC's footnote [2] defines a campaign as "the offer of the same good or service for the same seller". One `campaigns` row in our F02 schema = one campaign for FCC purposes. We do NOT roll up across campaigns; M03 reports per-campaign drop% with a tenant-wide breakdown but never a tenant-wide sum.

8. **Recovery is dwell-time-gated + hysteretic.** Naive recovery (release `drop_gated` the instant `drop_pct < 3.0%`) flaps badly under bursty traffic. Our scheme:
   - **Hysteresis**: gate engages at `drop_pct ≥ 3.0%`; gate releases only when `drop_pct ≤ 2.0%` (the "release threshold"). The 1-percentage-point band absorbs measurement noise.
   - **Dwell**: even when `drop_pct ≤ 2.0%`, the gate stays engaged for `campaigns.recover_seconds` (default 300 s = 5 min) past the moment of crossing. This gives the 30-day window time to actually age out the abandons.
   - **Manual override**: operator can `POST /api/admin/campaigns/:cid/drop-gate/release` (M03 button) to force-release before dwell elapses; audit-logged with operator user_id.
   See §10 for the state machine. This matches the EWMA + dwell pattern in modern adaptive dialer designs (Talkdesk [14], Five9 [15]) and is consistent with how E03's adaptive level engine recovers from over-shoot (per E03's owned design — to be ratified by E03 PLAN).

9. **Audit + evidence retention is 7 years (TCPA SoL + lookback margin).** TCPA statute of limitations is 4 years federal (28 USC 1658) but most state TCPA actions are 4 years + tolling [16][17]; serial-plaintiff "trolls" frequently demand 5+ years of records during discovery. The conservative industry standard is **7-year retention** for FCC abandonment evidence (DESIGN.md §10 SLAs line; LRS Cite [9]; CompliancePoint [12]). C04 owns retention at the table level; E05's responsibility is to **make sure every drop event has a durable evidence trail**. That trail is:
   - One `drop_log` row (partitioned by `dropped_at`) with `call_log_id` FK, `campaign_id`, `phone_e164`, `drop_reason`, `safe_harbor_played`, `dropped_at`
   - One `call_log.is_drop=true` flag with `status='DROP'` or `'PDROP'`
   - One `recording_log` row IF recording was on (per `campaigns.recording_mode`)
   - One `originate_audit` row (T04 owns) with the upstream attempt details
   - All five tables FK or join on `attempt_uuid` / `call_uuid` (the same string by the one-UUID rule, T04 PLAN §7)
   Total per-drop evidence weight: ~500 bytes amortized in DB + the recording WAV (~50 KB / minute compressed; per F02 default recording mode `ALL` an abandon is ~0-3 s of audio so usually <30 KB). At a 1% drop rate over a 50-CPS campaign × 7 years that's ~110 M rows × 500 B = ~55 GB in `drop_log` per tenant: well within the 200 GB/year F02 budget. Litigation hold (C04) freezes partition drops globally on demand.

10. **Open questions for PLAN (top 7 of 14).** (i) Where does the 2-second "no agent" timer live — in FreeSWITCH dialplan (`sched_hangup +2 SAFEHARBOR`) or in a Go answer-handler goroutine? **Recommend dialplan** for hard guarantee (timer fires even if Go process dies). (ii) Does the safe-harbor audio play in PARALLEL with agent-pick, or only AFTER pick fails at T+2 s? **Recommend AFTER** (cite [4]: "the recording must begin within 2 seconds" — playing during agent-pick is wasted bandwidth and triggers "did the agent miss the customer's hello?" UX bug). (iii) Soft cap action — page only, or also slow E03's level increase? **Recommend both** — E03 reads `drop_pct` directly per its own design; E05's soft-cap action is operator-page only. (iv) What if the campaign has no `safe_harbor_audio` configured? **Recommend reject originate** at T04's drop-cap gate (T04 stops originating before we abandon; safer than abandoning without the recording). (v) Should the gate threshold include a per-campaign override of the FCC 3% absolute cap (e.g., a regulated industry like healthcare wants 2% absolute cap)? **Recommend YES** via `campaigns.drop_target_max_override` column (F02 amendment) — but never allow > 3.0% (CI check). (vi) How does E05 interact with E04's picker when no agent is available? **Recommend E04 calls into E05's `RecordDrop` interface** (per E05.md "RecordDrop(ctx, callUUID, campaignID, reason)") — E04 is the only caller; T01's event handler is the fallback if E04 doesn't fire (e.g., crashed). (vii) Multi-tenant: in Phase 4, do tenants share the drop_gate state or is it isolated per-tenant? **Recommend isolated** — `t:{tid}:...` namespace already enforces this; document explicitly for HANDOFF.

---

## 2. The FCC rule — surgical reading of 47 CFR § 64.1200(a)(7)

This is the regulation we are enforcing. The full text (verbatim, with our annotations bracketed):

> § 64.1200(a)(7): "No person or entity shall initiate any telephone call to any residential line **[A]** using an artificial or prerecorded voice **[B]** to deliver a message **[C]** without the prior express written consent **[D]** of the called party … However, the prohibitions of § 64.1200(a)(7) do not apply to … a call by a telemarketer using a predictive dialer that abandons such a call only if: **[E]**
>   (i) the telemarketer employs technology that ensures abandonment of no more than three percent of all telemarketing calls answered by a live person, measured over a 30-day period for a single calling campaign **[F]**; …
>   (ii) the seller or telemarketer, for each telemarketing call placed, allows the telephone to ring for at least 15 seconds or four (4) rings before disconnecting an unanswered call **[G]**;
>   (iii) whenever a sales representative is not available to speak with the person answering the call within two (2) seconds after the called person's completed greeting **[H]**, the seller or telemarketer must promptly play a recorded message that states the name and telephone number of the seller on whose behalf the call was placed **[I]**;
>   (iv) the seller or telemarketer must maintain records establishing compliance with paragraph (a)(7) of this section **[J]**."

Decoded with the engineering hooks:

| Hook | What the regulation says | Where vici2 enforces |
|---|---|---|
| **[E] "Predictive dialer"** | The whole subsection only triggers for predictive (and progressive) dialers. Manual dial (a human agent clicking "dial") is exempt. | E05 enforces the gate ONLY when `campaigns.dial_method != 'MANUAL'`. Manual-dial campaigns have `drop_gated` permanently absent + drop_pct gauge not computed (saves ops). |
| **[F] "Three percent … over a 30-day period"** | Hard ceiling. Rolling window. Per campaign. | E05's hard cap (§2 bullet 2). MySQL `WHERE dropped_at >= NOW() - INTERVAL 30 DAY`. Valkey `XTRIM MINID <30d-ago>` nightly cron (F04 PLAN §4.3). |
| **[F] "calls answered by a live person"** | The DENOMINATOR. NOT all dials. NOT machines. NOT busy/NA. Only live humans. | E05's denominator query uses `s.human_answered=TRUE` (D04 flag — §1 bullet 6). |
| **[F] "single calling campaign"** | Aggregated per-campaign, not per-list, not tenant-wide. | E05 keys all state by `(tenant_id, campaign_id)`. M03 reports per-campaign. |
| **[G] "15 seconds or four rings"** | Originate-timeout floor. Not E05's job (T04 owns `originate_timeout`); E05's PLAN should add a defensive read of `campaigns.dial_timeout_sec >= 15` and refuse to start the campaign otherwise. | F02 schema check + E02 RESEARCH §12.4 ratification. E05 PLAN documents the cross-check. |
| **[H] "within two seconds … completed greeting"** | The 2-second clock. **Starts at the called party's "hello" (greeting completed), not at CHANNEL_ANSWER.** Practical implementation: most predictive dialers approximate "greeting completed" as `CHANNEL_ANSWER + 250 ms` (typical pre-greeting silence) OR `CHANNEL_ANSWER + speech-detect-event` (AMD-grade). | E05's answer-side terminator (§4). Phase 1 uses `CHANNEL_ANSWER + 2 s` as a conservative simplification (the customer hears "Hello" within ~250 ms, so the agent has ~1.75 s — still defensible; cite [11] for industry default). Phase 2.5 candidate: hook `mod_avmd`'s `voice_detect` event for true "greeting completed" timestamp. |
| **[I] "Promptly play a recorded message … name and telephone number of the seller"** | Safe-harbor audio MUST contain: (a) seller name; (b) seller phone number; (c) callback opt-out (interpreted from § 64.1200(b)(1) cross-reference). Some interpretations also require "this call was for telemarketing purposes" disclosure. | E05 owns the **terminator** (plays the audio); A05 / M02 admin UI owns **upload + validation** that the audio file exists and meets the format (§7). Per `campaigns.safe_harbor_audio` column (F02 schema §4.6; default NULL — campaign cannot start auto-dial without it). |
| **[J] "Maintain records establishing compliance"** | Evidence retention. 7 years industry-standard (§1 bullet 9). | C04 retention + `drop_log` + `call_log.is_drop`. E05 ensures the rows are written atomically with the abandon event. |

### 2.1 The "safe harbor" name is misleading

Casual reading suggests the safe-harbor audio is what gets you under 3%. It is not. The **3% ceiling itself is the safe harbor** (the carve-out from the otherwise-flat prohibition on prerecorded-voice telemarketing). The audio is an **additional requirement** the dialer must satisfy when it does abandon. If you fail the audio requirement, you fail the safe-harbor exemption, and every dropped call is now a § 64.1200(a)(7) violation (statutory damages $500–$1500 per call, no actual harm required — cite [17] TCPAWorld).

This is why the audio must be uploaded **before** any auto-dial campaign starts. E05's hard precondition (§4.7) — if `campaigns.safe_harbor_audio IS NULL` AND `dial_method != 'MANUAL'`, the campaign cannot transition to active. F02 schema check + M03 admin UI validation.

### 2.2 The "completed greeting" boundary

The regulation says "within two seconds after the called person's completed greeting" — not "two seconds after answer." This matters because:

- A customer who answers and immediately says "Hello?" has a completed greeting at ~500 ms post-`CHANNEL_ANSWER`. Our 2-s clock starts there, giving us ~1.5 s to bridge. Tight but doable for PROGRESSIVE.
- A customer who answers but says nothing (e.g., picks up and waits for whoever called to speak) has an UNCOMPLETED greeting indefinitely. The 2-s clock technically never starts. **But** the call is still happening, agents are still tied up, and the customer is still waiting. Industry consensus [4][6][11] is to start the 2-s clock at `CHANNEL_ANSWER` as a conservative simplification — never abandon LATER than "answer + 2 s", regardless of greeting status.
- The 2024 FCC "consent revocation rules" [10] do not alter the 2-s clock but clarify that "greeting completed" is judged from the customer's audible voice activity. Most implementations use `mod_avmd` or VAD (voice-activity-detection) to fire the speech-detected event; some (Vicidial) just use the answer time.

**Phase 1 choice: `CHANNEL_ANSWER + 2 s` as the deadline.** This is strictly more conservative than the regulation (we'll never abandon after the legal limit) and is the simplest. The CHANNEL_ANSWER timestamp from FreeSWITCH is millisecond-accurate (T01 PLAN logs it). When AMD lands (Phase 2.5), we'll consider hooking the speech-detected event for a more accurate clock, but it adds complexity for a marginal win.

### 2.3 The "abandon" verb has a specific meaning

The FCC carefully chose "abandons" rather than "fails to connect": an abandon REQUIRES (a) live human pickup + (b) failure to bridge + (c) within 2 s. A call that rings out (no answer) is not "abandoned" — it's "unanswered". A call answered by voicemail is not "abandoned" — it's a "machine answer". This is why the denominator MUST exclude machine answers: an abandon rate computed over all dials would be a lower number that looks better but is irrelevant to the regulation.

The corollary: the "abandon" verb implies the dialer made the decision to terminate. A customer who hangs up themselves before 2 s is technically a different event — but most enforcement actions [9][16] treat it as an abandon if it occurred during the 2-s window. Our default is conservative (count it; per-campaign override available, §1 bullet 5(ii)).

### 2.4 FCC 2003 + 2012 + 2024 rule history

- **2003** (FCC 03-153, July 25, 2003 — the "TCPA Order") [cite 2]: original 3% rule. Defined "single calling campaign" via 16 CFR § 310 cross-reference. Set the 30-day window. Authorized the safe-harbor exemption with audio.
- **2012** (FCC 12-21, Feb 15, 2012) [cite 3]: extended to wireless (cell phones) with prior express written consent. Did NOT change the 3% rule but tightened the consent definition.
- **2021** (FCC 21-3, Jan 5, 2021) [cite 10]: STIR/SHAKEN + call-blocking safe-harbor. Adjacent regulation; does not affect § 64.1200(a)(7) directly but creates the N05 branded-calling integration we'll need in Phase 4.
- **2024** (FCC 23-107, Feb 15, 2024) [cite 16]: "consent revocation" — relevant to D05 DNC, not E05.

Our enforcement is anchored on the **2003 rule** as currently codified at 47 CFR § 64.1200(a)(7). No subsequent rulemaking has altered the 3%/30-day/2-second numbers.

### 2.5 FTC TSR (16 CFR § 310.4(b)(4)) — parallel jurisdiction

The FTC's Telemarketing Sales Rule has its own abandonment rule at 16 CFR § 310.4(b)(4)(i) [cite 7]: same 3% cap, same 30-day window, same 2-second rule, same recorded-message exemption. The FCC rule and the FTC rule are "harmonized" — designed to be identical in substance. The TSR applies to interstate B2C telemarketing (FTC's TCPA-equivalent jurisdiction); the FCC rule applies to all telemarketing calls. **We comply with both** by enforcing the more conservative interpretation of any ambiguity. Phase 1: identical implementation suffices.

### 2.6 State-level addenda

A handful of states (CA, TX, FL, NY) have state-level abandonment rules that are NEVER MORE LENIENT than 3% but sometimes have stricter recording-message language requirements:

| State | Difference from federal | E05 handling |
|---|---|---|
| California (Bus & Prof Code § 17592) | Same 3%, same 30-day, but recording must say "this call was for sales purposes" verbatim | Per-campaign `safe_harbor_audio` must include the verbiage; admin UI validates upload metadata (M02 owns) |
| Texas (Bus & Comm Code § 304.252) | Same 3%, same window, but operator must additionally maintain "do not call" registry within 30 days | Out of E05 scope; D05 owns |
| Florida (Fla. Stat. § 501.059) | Same 3%, plus daily 8am–8pm calling restriction (already in C01) | E05 unaffected |
| New York (Gen Bus Law § 399-z) | Same 3%, plus written consent required for any prerecorded message | Mostly C01/D05; E05 unaffected |

None of the state rules change the 3% ceiling itself, so the gate-threshold math is uniform; only the safe-harbor audio content differs by state. Phase 1 ships with a single `safe_harbor_audio` per campaign + an optional `safe_harbor_audio_by_state` JSON map (F02 amendment, defer to Phase 3 — see §16 — when multi-state calling becomes common).

---

## 3. Safe-harbor audio + the "safe harbor" exemption mechanics

### 3.1 Required content of the audio

Per 47 CFR § 64.1200(a)(7)(iii) + § 64.1200(b)(1) cross-reference:

| Element | Required? | Source language |
|---|---|---|
| Seller name (the company the call is for) | YES | "(a)(7)(iii) … the name … of the seller on whose behalf the call was placed" |
| Seller phone number | YES | "(a)(7)(iii) … the telephone number" — a number "that permits any individual to make a do-not-call request during regular business hours" |
| "This call was for telemarketing purposes" | RECOMMENDED (most state interpretations require it) | implied from § 64.1200(b)(1) "must state that the purpose of the call is to sell goods or services" |
| Opt-out instruction (DNC request mechanism) | YES | § 64.1601 + § 64.1200(d) — the called party must be able to add themselves to the seller's DNC list |
| Recording date/time | NO | not regulatory; some operators include for forensic purposes |

Length: typical 8–15 seconds. Most operators ship a ~10-second WAV.

### 3.2 Audio file format requirements

Per E05.md skeleton + DESIGN.md §6.3 ("safe-harbor audio plays before hangup") + FS playback subsystem:

- **Format**: 8 kHz mono PCM WAV (matches PSTN narrowband G.711) OR 16-bit linear at 8 kHz. MP3 acceptable but FS prefers WAV (avoids transcoder hop).
- **Sample rate**: 8 kHz (matches phone audio). Higher sample rates auto-downsample inside FS but waste bandwidth and add latency.
- **Channels**: mono. Stereo plays only the left channel through the phone; right channel is silent.
- **Encoding**: u-law (G.711µ) or A-law (G.711A) preferred (no transcoding). Linear PCM works but FS transcodes per leg.
- **Duration**: 5–15 seconds. Less than 5 s is unprofessional; more than 15 s ties up the line too long for an abandon event.
- **Loudness**: -16 LUFS recommended (broadcast loudness; matches typical PSTN). Avoid clipping; -3 dBFS peak max.
- **Pre-roll**: NONE. The audio must start immediately on play; any leading silence eats into the 2-second window.

The M02 admin UI (upload module) validates these properties at upload time; the file lives in shared storage `/var/lib/freeswitch/sounds/custom/safe_harbor/<campaign_id>.wav` (or S3 with FS `mod_http_cache`). T01's dialplan does `playback /path/to/safe_harbor.wav` then `hangup`.

### 3.3 The exemption is a count limit, not an event reclassification

A common operator misconception: "if we play the safe-harbor audio, the call doesn't count as an abandon." **WRONG.** The safe-harbor exemption is a **per-campaign-30-day count cap** — the campaign can abandon up to 3% of live-answered calls WHEN the safe-harbor audio plays for each of those abandons. If the audio doesn't play (e.g., audio file missing, dialplan crashed), each such call is a **per-call violation** of § 64.1200(a)(7) (no exemption available).

In our schema:
- `drop_log.safe_harbor_played` = TRUE means the audio actually played (T01 dialplan emitted the `playback_started` event; E05 sets the flag after receiving the FreeSWITCH `CHANNEL_EXECUTE_COMPLETE` event)
- `drop_log.safe_harbor_played` = FALSE means we tried but failed (audio file missing, FS errored mid-play, channel hung up before play started) — these are the operator-page events
- `call_log.is_drop=true` is set for BOTH cases — both still count toward the 3% denominator/numerator
- BUT a `drop_log.safe_harbor_played=false` row is a SEV1 operator alert (page) because it's a per-call legal exposure

Reporting (M08): TCPA report shows both numbers — total drops AND drops without safe-harbor audio. The latter must be zero or the operator has a serious problem.

### 3.4 What plays during the 2-second pre-bridge window

For maximum operator and regulatory clarity, here is the exact sequence:

| t | Event | What plays | Who emits |
|---|---|---|---|
| 0 ms | CHANNEL_ANSWER from carrier | (silence — agent pick is racing) | T01 |
| 0–2000 ms | E04 attempts agent-pick via `pick_agent_for_call.v1.lua` | (silence) | E04 |
| ≥0 ms (anytime <2000 ms) | Agent picked + bridged | (agent + customer audio, on conference) | E04 / T01 / T03 |
| 2000 ms | sched_hangup fires from dialplan-installed timer | safe-harbor audio starts playback | T01 dialplan (E05 owns the XML) |
| 2000–12000 ms | safe-harbor audio plays (typical 10 s) | seller name, phone, opt-out | mod_dptools `playback` |
| 12000 ms | playback completes; hangup | (silence then disconnect) | T01 dialplan |
| 12000 ms | E05 ESL handler receives `playback_stop` + `CHANNEL_HANGUP_COMPLETE` events; writes `drop_log` + sets `call_log.is_drop=true` + XADDs to `drop_window` | (no audio) | E05 ESL handler |

The dialplan extension lives at `freeswitch/conf/dialplan/default/45_safe_harbor.xml`. The 2-second sched_hangup is installed at originate-time via the channel-var `execute_on_answer=sched_hangup:+2 NORMAL_CLEARING SAFE_HARBOR_TIMEOUT` (or `sched_transfer:+2 safe_harbor XML default`, depending on FS version — see §4.6 for the implementation choice).

### 3.5 If safe-harbor audio is missing

E05 PRECONDITION at campaign start: `campaigns.safe_harbor_audio IS NOT NULL` for `dial_method != 'MANUAL'`. Enforced by:

- F02 schema (CHECK constraint — Phase 2 amendment)
- M02 admin UI (campaign-edit validation)
- T04 originate-time gate (`gateDropCap` — Phase 2 amendment adds a "config-validity" sub-check)
- E02 startup (refuse to spawn pacer goroutine if audio missing)

If somehow we end up dialing without audio AND we abandon, T01's dialplan plays a hardcoded fallback audio (`fallback_safe_harbor.wav` baked into the FS install, generic "this call was for marketing purposes; to opt out please contact your carrier" text) AND E05 raises a SEV1 alert. This is a defense-in-depth — we should never reach this state, but if we do, the legal exposure is mitigated.

### 3.6 PDROP vs DROP — the distinction

- **DROP**: Customer answered, no agent within 2 s, safe-harbor audio played. Status `DROP`, `call_log.is_drop=true`, `drop_log.safe_harbor_played=true`, `drop_log.drop_reason='no_agent'`. Counts in numerator + denominator. Legal: covered by safe-harbor exemption IF the campaign's 30-day rate < 3%.
- **PDROP**: Pre-route drop. Customer answered, but our software dropped the call BEFORE attempting to bridge (e.g., E04 picker errored, T01 hangup race, etc.). Safe-harbor audio probably did NOT play (the race that caused the pre-drop also raced the audio playback). Status `PDROP`, `call_log.is_drop=true`, `drop_log.safe_harbor_played=false`, `drop_log.drop_reason='timeout'` or `'queue_full'`. Counts in numerator + denominator. Legal: each PDROP is a per-call violation (no exemption). PAGE operator on every PDROP.

PDROP rate should be near zero (target: <0.01% — basically only on software bugs). Industry [13] reports PDROP rates of 0.05–0.1% in well-run shops; >0.5% means something's broken in the pacing pipeline.

### 3.7 Two-rep-on-one-call exemption

Subtle FCC clarification [cite 2 footnote]: if a campaign has a "front-end" rep (qualifier) and a "back-end" rep (closer), the 2-second clock is satisfied when EITHER bridges. Vicidial supports this via "in-group cascade." For Phase 2 we have a simple agent-pick (E04 picks one agent); the qualifier-vs-closer is out of E05 scope. Document for I04 (closer logic) PLAN.

---

## 4. The answer-side terminator (the 2-second timer + audio playback)

This is the core E05 mechanism: a hard guarantee that no call abandons silently or after 2 s.

### 4.1 Implementation choice: FreeSWITCH dialplan extension

Three options were considered:

| Option | Mechanism | Pro | Con |
|---|---|---|---|
| (A) Dialplan `sched_hangup` | FS XML extension fires hangup at T+2 s unless bridged earlier | Hard real-time guarantee inside FS event loop; survives ESL disconnect; survives Go process crash | Audio playback before hangup requires `sched_transfer` to a "safe_harbor" extension that does playback + hangup |
| (B) Go answer-handler goroutine | E04 / E05 spawns `time.AfterFunc(2*time.Second, ...)` that calls `bgapi uuid_kill --reason=safe_harbor` | Easier to test; logic in Go (not XML) | If Go crashes during the 2 s, customer is stuck on a silent call; relies on ESL round-trip |
| (C) Hybrid — Go starts the timer, but dialplan has a 5-s backstop `sched_hangup +5 SAFETY_NET` | Both layers fire; Go is the primary, dialplan is backup | Most defensive; adds complexity | Two timers can race for "who hung up?" — observability nightmare |

**Recommendation: (A) — dialplan `sched_transfer`.** Rationale:

- The FS event loop is more reliable than a Go process — FS has been running this pattern in production at Vicidial scale for 15 years
- The 2-second deadline is a HARD legal floor; we want maximum determinism
- The audio playback is one dialplan action (`playback` + `hangup`) — no extra Go logic
- Crash-safety: even if our Go services all die, the customer still hears the safe-harbor message and gets disconnected cleanly

The dialplan extension at `freeswitch/conf/dialplan/default/45_safe_harbor.xml`:

```xml
<extension name="safe_harbor">
  <condition field="destination_number" expression="^safe_harbor$">
    <action application="set" data="hangup_after_bridge=true"/>
    <action application="set" data="vici2_safe_harbor_played=true"/>
    <action application="playback" data="${safe_harbor_audio_path}"/>
    <action application="set" data="hangup_cause=NORMAL_CLEARING"/>
    <action application="hangup"/>
  </condition>
</extension>
```

The channel-var `safe_harbor_audio_path` is set at originate-time by T04 from `campaigns.safe_harbor_audio` (with fallback). The transfer to this extension is installed at originate-time via `execute_on_answer=sched_transfer:+2 safe_harbor XML default`.

### 4.2 The race: agent-pick vs sched_transfer

At `CHANNEL_ANSWER`:

```
T+0 ms:     CHANNEL_ANSWER fires (carrier signaled answer)
T+0 ms:     E04 picker goroutine launched: pick_agent_for_call.v1.lua
T+50 ms:    Lua returns user_id of longest-waiting READY agent (or nil)
T+50 ms:    If user_id: E04 issues uuid_transfer to agent's conference
T+100 ms:   Conference bridge fires CHANNEL_BRIDGE; sched_transfer NEVER FIRES (transfer is to a different extension)
T+0 ms:     Meanwhile: sched_transfer +2 safe_harbor was installed at CHANNEL_CREATE; timer is ticking
T+2000 ms:  If no bridge happened, sched_transfer fires; channel jumps to safe_harbor extension; audio plays; hangup.
```

The race is **safe** because:
- A successful agent-bridge moves the channel out of the originate-leg state; FreeSWITCH's `sched_transfer` does NOT fire on a transferred channel (the schedule attaches to the channel UUID; after bridge, the customer leg is bridged but still "owns" the schedule — but `sched_transfer` to a different destination AFTER bridge is suppressed by the `app_loop` guard in mod_dptools).
- Even if the timer fires AFTER a successful bridge (race condition window), the bridged customer leg has `hangup_after_bridge=true`, so any state change cancels the schedule. Worst case: a stray "transfer" event observed in logs; not user-visible.

For belt-and-suspenders, E04's bridge handler also issues `uuid_setvar <call_uuid> vici2_safe_harbor_cancelled true`, which the safe_harbor extension reads as a no-op flag (skips audio playback if the bridge happened in the last 100 ms).

### 4.3 What FreeSWITCH sees at the originate-time setup

```
bgapi originate {
  origination_uuid=<attempt_uuid>,
  vici2_attempt_uuid=<attempt_uuid>,
  origination_caller_id_number=+12125550100,
  ...
  ignore_early_media=true,
  originate_timeout=22,
  hangup_after_bridge=true,
  safe_harbor_audio_path=/var/lib/freeswitch/sounds/custom/safe_harbor/SOLAR_Q2.wav,
  execute_on_answer=sched_transfer:+2 safe_harbor XML default,
  ...
}sofia/gateway/twilio_main/+14155550199 &park()
Job-UUID: <attempt_uuid>
```

The `&park()` is required because the originate is a PARK target — E04 will later transfer it to a conference. The `execute_on_answer` runs at `CHANNEL_ANSWER`, scheduling the safe_harbor transfer for +2 s. If E04 bridges in that window, the schedule never fires (bridged channels don't process schedules).

### 4.4 What E05's Node ESL handler does on the events

E05 subscribes to two FreeSWITCH events via the api/src/esl/ infrastructure:

| Event | Trigger | E05 action |
|---|---|---|
| `CUSTOM safe_harbor::played` (we emit a custom event from the dialplan) | Audio playback finished | UPDATE `drop_log SET safe_harbor_played=true WHERE call_uuid=?` — though typically the row is written AFTER hangup, so this just sets a flag in Valkey for the upcoming write |
| `CHANNEL_HANGUP_COMPLETE` with `vici2_safe_harbor_played=true` channel-var | Channel hung up after safe-harbor played | INSERT `drop_log` row with `safe_harbor_played=true, drop_reason='no_agent'`; UPDATE `call_log SET is_drop=true, status='DROP'`; XADD to `drop_window` STREAM with `answered=1, dropped=1` |
| `CHANNEL_HANGUP_COMPLETE` with `vici2_safe_harbor_played` ABSENT but call was answered | Channel was answered + hung up without audio (e.g., pre-bridge race) | INSERT `drop_log` row with `safe_harbor_played=false, drop_reason='timeout'` (or queue_full); UPDATE `call_log SET is_drop=true, status='PDROP'`; XADD to `drop_window` STREAM; **PAGE** operator (SEV1) |
| `CHANNEL_HANGUP_COMPLETE` after `CHANNEL_BRIDGE` was reached | Normal flow (agent connected, then hangup) | NO drop_log row. T01's normal CHANNEL_HANGUP_COMPLETE handler does CDR finalization |

The handler at `api/src/esl/handlers/safe-harbor-played.ts` is ~80 LOC of TypeScript: parse event, lookup call_log_id, INSERT drop_log, UPDATE call_log, XADD drop_window. All within one MySQL transaction for atomicity (cite [9] retention discovery requirement).

### 4.5 What if the safe-harbor audio file is missing

T01's dialplan `playback` of a missing file errors at runtime; the channel proceeds to `hangup` immediately. The `vici2_safe_harbor_played` var is NOT set (the playback never started). E05's handler sees `CHANNEL_HANGUP_COMPLETE` without the flag → writes `drop_log.safe_harbor_played=false` and pages operator.

**To prevent this**: E02 startup time validates the audio path is readable (file exists; mode 444+; non-zero size). If missing, refuses to start the pacer for that campaign and writes M03 admin error. Per §3.5.

### 4.6 Why not `sched_hangup` instead of `sched_transfer`?

`sched_hangup +2 NORMAL_CLEARING` is simpler — fires hangup at T+2 s. But it skips the audio playback entirely. That's only acceptable in the (rare) case where the campaign is explicitly configured WITHOUT safe-harbor audio (which we reject — §3.5). Operationally, `sched_hangup` is the fallback if `sched_transfer` is unavailable (older FS versions); `sched_transfer` to a `safe_harbor` extension is the standard implementation.

Per Vicidial cite [14], `AST_VDauto_dial.pl` actually uses the simpler `sched_hangup` + a separate "if abandoned, queue audio at the agent-pick handler" sequence. We choose `sched_transfer` because (a) it's tighter (one mechanism, one trace), (b) FS 1.10+ supports it reliably, and (c) it survives ESL disconnect (Go can't intervene to "queue the audio" if ESL is down).

### 4.7 The "configured but no agent at all" case

What if the campaign has zero READY agents AND we still originated (E02 bug)? CHANNEL_ANSWER fires; E04 finds no agent (`pick_agent_for_call.v1.lua` returns nil); sched_transfer fires at T+2 s; safe-harbor audio plays; hangup. The drop is recorded; the operator sees a SEV1 alert (E04 should have prevented this — E02's clamp #1 plus the min_call_buffer_clamp should not have permitted the originate). E05 doesn't have a separate handler for "all agents gone mid-call" — that's E04's bug.

### 4.8 What about the originator-side caller hangup

If the customer answers and immediately hangs up before T+2 s:
- `CHANNEL_HANGUP_COMPLETE` fires with `hangup_cause=ORIGINATOR_CANCEL` (the customer was the originator of the BYE)
- `vici2_safe_harbor_played` is NOT set
- E05's handler sees `CHANNEL_HANGUP_COMPLETE` BEFORE `CHANNEL_BRIDGE` → counts as DROP (or doesn't — see §1 bullet 5(ii) — `campaigns.count_early_customer_hangup_as_drop` controls)
- If counted: written to drop_log with `safe_harbor_played=false, drop_reason='customer_hangup_early'`
- The numerator denominator math is identical whether we count it or not (it's `is_drop=true` vs `is_drop=false` — both go in denominator since `human_answered=true`)

For the strict reading (default), count it. The operator-facing report distinguishes "customer-initiated early hangups" from "we ran out of time" — useful for diagnosing whether the safe-harbor audio is starting fast enough.

---

## 5. Schema — what E05 reads, writes, and the dual-write contract

### 5.1 What E05 reads

| Source | Path | Purpose | Cadence |
|---|---|---|---|
| MySQL `drop_log` | `SELECT COUNT(*) FROM drop_log WHERE tenant_id=? AND campaign_id=? AND dropped_at >= NOW() - INTERVAL 30 DAY` | numerator (authoritative) | 15 s (E05 ticker) |
| MySQL `call_log` JOIN `statuses` | `SELECT COUNT(*) FROM call_log c JOIN statuses s ON c.status=s.status WHERE c.tenant_id=? AND c.campaign_id=? AND c.call_started >= NOW() - INTERVAL 30 DAY AND s.human_answered=TRUE` | denominator (authoritative) | 15 s (E05 ticker) |
| Valkey STREAM `t:{tid}:campaign:{{cid}}:drop_window` | `XLEN` + filter (or two `XLEN` on virtual sub-streams; see §5.5) | numerator + denominator (fast path, advisory) | 1 Hz (E03, S01 reads) |
| MySQL `campaigns` row | `SELECT adaptive_drop_pct, drop_target_soft, recover_seconds, safe_harbor_audio FROM campaigns WHERE id=?` | thresholds + audio config | 60 s (process cache) |
| FS ESL events | `CHANNEL_ANSWER`, `CHANNEL_HANGUP_COMPLETE`, `CHANNEL_BRIDGE`, `CUSTOM safe_harbor::played` | terminator event sequencing | per-call |

### 5.2 What E05 writes

| Destination | Path | Purpose | Cadence |
|---|---|---|---|
| MySQL `drop_log` (INSERT) | new row per abandon | TCPA evidence | per-drop |
| MySQL `call_log` (UPDATE) | `SET is_drop=true, status='DROP' WHERE uuid=?` | reporting + denominator agreement | per-drop |
| Valkey STREAM `t:{tid}:campaign:{{cid}}:drop_window` (XADD) | `answered=1, dropped=1, ts, call_uuid` | fast-path tracking | per-drop |
| Valkey STRING `t:{tid}:campaign:{{cid}}:drop_pct` | `"2.41"` (decimal text) | gauge for E02 + E03 + O01 | 15 s ticker |
| Valkey STRING `t:{tid}:campaign:{{cid}}:drop_gated` | `"1"` or absent | binary gate for E02 clamp | on transition only (engage/release) |
| Valkey STRING `t:{tid}:campaign:{{cid}}:drop_count_30d` | `"127"` (integer) | cached numerator | 15 s ticker |
| Valkey STRING `t:{tid}:campaign:{{cid}}:drop_denominator_30d` | `"5267"` (integer) | cached denominator | 15 s ticker |
| Valkey STRING `t:{tid}:campaign:{{cid}}:drop_gate_engaged_at` | `"2026-05-13T14:32:11Z"` (RFC3339) | dwell-tracking timestamp | on engage |
| Valkey STREAM `t:{tid}:campaign:{{cid}}:drop_gate_transitions` | append `{ts, action: engage|release, drop_pct, source: auto|operator}` | audit trail; M03 displays | on transition |
| Prometheus metrics | `vici2_e05_drop_rate_pct{tenant,campaign}`, etc. | observability | on each compute |

### 5.3 The `drop_window` STREAM (re-stated from F04)

Per F04 PLAN §4.3:

```
Key:    t:{tid}:campaign:{{cid}}:drop_window
Type:   STREAM
Entry:  XADD ... MAXLEN ~ 500000 *
        field:  answered (0|1)
        field:  dropped  (0|1)
        field:  ts (ms)
        field:  call_uuid
Trim:   nightly XTRIM MINID <30d-ago-ms-id> (cron-driven)
Size:   ~18 B/entry × 90 k entries/30 d = 1.6 MB/campaign × 50 campaigns = 81 MB
```

The writer is T01's `record_call_outcome.v1.lua` (F04 PLAN §6.3), called from T01's `CHANNEL_HANGUP_COMPLETE` handler. T01 already writes `answered=1, dropped=0` (for normal bridged calls) and `answered=1, dropped=1` (for abandons). E05 reads, never writes to this stream — but E05 verifies its consistency vs `drop_log` (the reconciler — §5.7).

Wait — there's an ambiguity: who flips `dropped=1` in the STREAM entry? Two candidates:

- (A) T01's CHANNEL_HANGUP_COMPLETE handler reads `vici2_safe_harbor_played` channel-var and decides
- (B) E05's ESL handler reads the same, but ALSO writes a separate XADD with `dropped=1`

We choose **(A)**: T01 is the canonical writer per F04 PLAN. E05 writes `drop_log` (MySQL) and updates `call_log.is_drop` (MySQL), but does NOT write to the STREAM (avoids double-counting). Per F04's record_call_outcome.v1.lua signature, the `dropped` ARGV is passed in by the caller (T01's handler). T01 sets `dropped=1` if `vici2_safe_harbor_played=true` OR if `(answered AND NOT bridged)` (the pre-bridge race case).

The contract: T01 owns STREAM atomicity, E05 owns MySQL atomicity. Both fire at `CHANNEL_HANGUP_COMPLETE`. E05's reconciler (§5.7) verifies they agree within 0.05% tolerance.

### 5.4 The `drop_log` table (re-stated from F02 schema §4.27)

```prisma
model DropLog {
  id               BigInt     @default(autoincrement())
  tenantId         BigInt     @default(1) @map("tenant_id")
  callLogId        BigInt?    @map("call_log_id")
  campaignId       String     @map("campaign_id") @db.VarChar(32)
  phoneE164        String     @map("phone_e164") @db.VarChar(16)
  droppedAt        DateTime   @map("dropped_at") @db.DateTime(6)
  dropReason       DropReason @map("drop_reason")
  safeHarborPlayed Boolean    @default(false) @map("safe_harbor_played")
  createdAt        DateTime   @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt        DateTime   @default(now()) @map("updated_at") @db.DateTime(6)

  @@id([id, droppedAt])
  @@index([tenantId, campaignId, droppedAt], map: "idx_drop_log_t_camp_dropped")
  @@index([tenantId, callLogId], map: "idx_drop_log_t_call")
  @@map("drop_log")
}

enum DropReason { no_agent, timeout, queue_full }
```

E05 PLAN proposes a F02 amendment to **extend the enum**:

```
enum DropReason {
  no_agent,                  // E04 picker returned nil agent within 2 s
  timeout,                   // sched_transfer fired (no agent pick at all)
  queue_full,                // E04 returned "all agents at capacity"
  customer_hangup_early,     // customer hung up < 2 s post-answer (per §1 bullet 5(ii))
  audio_missing,             // safe-harbor audio file not playable
  software_error             // catch-all; SEV1 alert always
}
```

Plus a new column `originator_attempt_uuid VARCHAR(40)` to forward-link to `originate_audit` (already implied via call_log_id JOIN, but redundant FK is cheap and discovery-friendly). See §16 PLAN open Q.

### 5.5 Why a STREAM, not a counter

A common alt-design: Valkey STRINGs incremented on each event (`INCR t:{tid}:campaign:{cid}:answered_count`, `INCR t:{tid}:campaign:{cid}:dropped_count`). Why not?

- **Counters can't be rolling-windowed** without an external time-bucket scheme (e.g., 30 daily counters and you SUM the last 30). That works but adds complexity.
- **Counters lose forensic detail.** If we get a TCPA discovery request "list every abandoned call between 2026-04-01 and 2026-04-15 for campaign SOLAR_Q2", we want a stream we can replay; a counter can't tell us that.
- **STREAM size is fine.** 90 k entries × 18 B = 1.6 MB per campaign. 50 campaigns = 81 MB. Trivial.
- **STREAMs have XAUTOCLAIM**, which provides recovery semantics if a consumer dies mid-XADD; counters don't.

The drawback of STREAMs: XLEN with filter requires `XRANGE` + filter, which is O(N) in entries. For a 90-k entry stream that's a ~5 ms read — fine for our 15-s recompute cadence. For a 1-Hz hot read by E02 (which reads the cached `drop_pct` STRING, not the stream directly), the STRING is O(1).

### 5.6 The cached gauges (`drop_pct`, `drop_gated`, `drop_count_30d`, `drop_denominator_30d`)

E05's 15-s ticker computes:

```
numerator   = SELECT COUNT(*) FROM drop_log WHERE tenant_id=? AND campaign_id=? AND dropped_at >= NOW() - INTERVAL 30 DAY
denominator = SELECT COUNT(*) FROM call_log c JOIN statuses s ON ... WHERE c.tenant_id=? AND c.campaign_id=? AND c.call_started >= ... AND s.human_answered=TRUE
drop_pct    = 100.0 * numerator / max(denominator, 1)

valkey.set(t:{tid}:campaign:{{cid}}:drop_count_30d, numerator)
valkey.set(t:{tid}:campaign:{{cid}}:drop_denominator_30d, denominator)
valkey.set(t:{tid}:campaign:{{cid}}:drop_pct, format("%.2f", drop_pct))
```

These STRINGs are read by:
- **E02** (pacing tick at 1 Hz): reads `drop_gated` for clamp #3 (E02 RESEARCH §3.4). RESP3 client-cached, ~50 µs per read.
- **E03** (adaptive engine at 15 s): reads `drop_pct` to decide whether to raise/lower dial-level. E03 has its own logic; E05 just publishes.
- **O01** (Grafana): scrapes Prometheus `vici2_e05_drop_rate_pct` (same value, exported as gauge).
- **S01** (supervisor wallboard): subscribes to a pubsub broadcast on the same value, refreshed each ticker.
- **T04** (originate-time drop-cap gate): reads `drop_pct` for the `gateDropCap` check (T04 PLAN §3.2 — Phase 1 stubs ALLOW; this PLAN ratifies "E05 wires it").

### 5.7 The reconciler (Valkey STREAM vs MySQL drop_log)

Every 60 s, E05 runs a reconciler:

```
stream_dropped_30d = XRANGE drop_window ... | filter dropped=1 | count
db_dropped_30d     = SELECT COUNT(*) FROM drop_log WHERE ... INTERVAL 30 DAY

if abs(stream_dropped_30d - db_dropped_30d) / max(db_dropped_30d, 1) > 0.0005:
    alert("drop_window stream drift", details)
    use db_dropped_30d as authoritative  # MySQL wins (TCPA evidence)
```

Why 0.05% tolerance? At 50 CPS with 1% drop rate, a campaign produces ~43 abandons/day = ~1300/month. 0.05% drift = 0.65 calls; reasonable cold-start race. Higher drift means something is broken (T01 STREAM write failing; E05 MySQL write failing; clock skew).

When drift > 0.05% but < 1%: log + alert WARN, continue using MySQL. When > 1%: alert PAGE; freeze the campaign (set `drop_gated=1` defensively) until operator clears.

Per F02 PLAN's "TCPA evidence" principle: MySQL is always authoritative. Valkey is a fast cache.

### 5.8 Cold-start state recovery

If E05 restarts (pod crash, redeploy), the in-memory state (last gate transition time; per-campaign cached threshold) is lost. Recovery:

1. On startup, for each active campaign:
   - SELECT thresholds from `campaigns` row (process-cache for 60 s)
   - Recompute numerator + denominator from MySQL (fresh — never trust Valkey on cold start)
   - SET `drop_pct`, `drop_count_30d`, `drop_denominator_30d` STRINGs
   - If `drop_pct >= drop_target_max`: SET `drop_gated=1`, record `drop_gate_engaged_at=now`
   - If currently engaged but `drop_pct < drop_target_max - hysteresis`: leave engaged until dwell elapses (read engage timestamp from STREAM `drop_gate_transitions`)

This is ~3 ms per campaign; 50 campaigns = ~150 ms startup; reasonable.

### 5.9 Per-tenant isolation

All keys are `t:{tid}:campaign:{{cid}}:*` with the tenant ID prefix. F04's hash-tag pattern ensures per-campaign keys colocate on one Cluster shard. Cross-tenant access is prevented by the key prefix; no Lua script accepts a different `tenant_id` than its `KEYS[]` prefix.

In Phase 4 (multi-tenant SaaS), the same code Just Works — each tenant has independent counters. The MySQL queries are `WHERE tenant_id=?` (already in F02 schema). No special handling.

---

## 6. Numerator/denominator edge cases (the long tail)

This section catalogues every gotcha we found in [4][6][9][11][13]. Each case has an explicit rule.

### 6.1 AMD-classified human (false-positive AMD)

**Scenario**: A real person picks up, says "Hello? Hello?" twice, then waits. `mod_avmd` decides this is an answering machine because the cadence looks like a VM greeting. Channel hangs up with status `AA` (system AMD detected). `human_answered=false`. NOT counted in numerator or denominator.

**Risk**: We may have abandoned a real customer and the FCC count doesn't show it. Worse: we played the "this is for telemarketing purposes" recording into someone's voicemail.

**Mitigations**:
- AMD off by default (per DESIGN.md §1.2 key knobs: "Start without AMD"); explicit campaign opt-in
- Monitor `vici2_amd_machine_classification_total{campaign}` — if `>20% of all answers`, alert (AMD is mis-calibrated)
- `machine_terminal=true` per campaign (default) means we DON'T retry AMD-detected leads (saves repeat dials)
- Phase 3+: Add `human_validated_after_amd` flag — if AMD said machine but agent later disposes as "SALE", flip the AMD classification in retrospect (audit-logged)

### 6.2 Human-who-hangs-up-before-2s

**Scenario**: Customer answers, says "Who is this?", hears silence (we're racing the agent-pick), hangs up at T+1.2 s. `CHANNEL_HANGUP_COMPLETE` fires with `hangup_cause=ORIGINATOR_CANCEL`, no `vici2_safe_harbor_played`, no `CHANNEL_BRIDGE`.

**Interpretation**:
- Strict (conservative; our default): count as abandon. Status `PDROP`. `safe_harbor_played=false`. `drop_reason='customer_hangup_early'`.
- Lenient: don't count (customer chose to hang up; we didn't get to the 2-s line). Some operators use this; it's defensible but adversarial.

**Default**: count it. Per-campaign override `campaigns.count_early_customer_hangup_as_drop` (F02 amendment) allows the lenient interpretation. M03 admin UI shows a warning when the toggle is flipped to lenient.

Why default conservative: discovery in TCPA litigation [9] sometimes asks for "all calls where customer answered and was not connected to an agent". The conservative count produces the same number on both sides; the lenient count produces a different number, which a plaintiff's attorney will argue is undercounting.

### 6.3 Answered-then-bridged-after-2-seconds (the "late bridge")

**Scenario**: E04's picker takes 2.3 s to find an agent (Valkey was slow). The sched_transfer fires at T+2 s, safe-harbor playback begins, E04 then tries to bridge at T+2.3 s.

**Result**: The bridge attempt fails because the channel is now in the `safe_harbor` extension (already transferred). E04's transfer command returns an error; the call hangs up after the audio.

Status: `DROP` (with `safe_harbor_played=true`). E04's metric `vici2_e04_pick_latency_seconds` should have alerted before this — anything >1 s is a problem. E05 doesn't need special handling; the dialplan race is correct.

### 6.4 Answer event but no audio (e.g., silent answer)

**Scenario**: Customer answers (carrier signals 200 OK + media) but never says anything. `CHANNEL_ANSWER` fires; no voice activity. The 2-s clock starts at `CHANNEL_ANSWER` per §2.2; safe-harbor audio plays at T+2 s.

This is the normal flow; no special handling.

### 6.5 Fax-detected-then-human (very rare)

**Scenario**: AMD says fax, then real audio appears (fax machine reroute to a human?). FS doesn't hang up because `amd_action` is the AMD result — but if AMD says fax, status is `AFAX` (`human_answered=false`).

**Issue**: If a human did pick up (rare), we'd never know — AMD ended the call.

**Mitigation**: AMD is off by default. Phase 3+ AMD has a `dual_listen` mode (continue audio detection past initial classification); not in scope here.

### 6.6 Bridged but agent never said hello

**Scenario**: E04 bridges customer to agent at T+1.5 s. Agent has audio path open but their headset is muted or they're in the bathroom. Customer says "Hello?" gets no response, hangs up at T+5 s.

**Status**: This is BRIDGED, then customer hangup. Counts in denominator (`human_answered=true`), NOT in numerator (the bridge happened — abandonment is about FAILURE TO BRIDGE, not failure to talk). Status will be set by the agent's eventual disposition (likely `ERI` since they never disposed, or `N` if they manually disposed as "no answer/silent").

**FCC interpretation**: This is NOT an abandonment under § 64.1200(a)(7) — the bridge occurred. It might be a different problem (agent productivity, training) but not a TCPA issue.

### 6.7 Network-disconnect-mid-greeting

**Scenario**: Customer answers, customer says "Hi", carrier-side network blip drops the call at T+1.0 s. `hangup_cause=NETWORK_OUT_OF_ORDER`.

**Interpretation**:
- The customer answered (`CHANNEL_ANSWER` fired) → `human_answered` is `true` if we know
- We didn't bridge → looks like an abandon
- But the cause was network, not our fault

**Default**: count as abandon (`PDROP`, `drop_reason='timeout'`). The FCC doesn't have a "network blame" exception. The compensating control: monitor `hangup_cause=NETWORK_*` rates — if elevated, alert (carrier issue).

Aggressive mitigation: if `hangup_cause=NETWORK_*` is observed within 2 s of answer, AND no `vici2_safe_harbor_played`, count as PDROP. Operator can dispute via M03 manual reclassification (audit-logged) if they have carrier records.

### 6.8 Pre-route drops (PDROP)

**Scenario**: Customer answered, dialer was supposed to play safe-harbor + log, but the ESL connection died, or the Go process crashed, or E04 errored, etc. The customer hangs up after waiting; we have no record of what happened until CHANNEL_HANGUP_COMPLETE arrives belatedly.

**Status**: `PDROP`. `drop_reason='timeout'` or `'software_error'`. `safe_harbor_played=false`. **Always page operator** — PDROPs are bugs.

**Reporting**: Per §3.6, PDROPs count in numerator. The operator KPI: PDROP rate < 0.01%.

### 6.9 Agent un-paused mid-2s-window

**Scenario**: At T=0 customer answers, E04 picks no agent (none READY). At T=0.5 s an agent un-pauses (PAUSED→READY transition). At T=2 s sched_transfer fires.

**Question**: Should we have aborted the safe-harbor and bridged to the now-available agent?

**Answer**: NO — too risky. The 2-s deadline is firm. Aborting requires a race-free "cancel the schedule + transfer + play X" sequence that can't be done atomically in FS dialplan. The 0.5-s late agent will pick the NEXT call.

But: E02's clamp #1 (`min_call_buffer_clamp`) should have prevented the originate IF E03 predicted the agent wouldn't be free in time. So this scenario implies E03's prediction was wrong. Acceptable in Phase 2.

### 6.10 The "rapid-fire" customer

**Scenario**: Customer answers, says "Yes?", hangs up at T+0.3 s before anyone (including the safe-harbor audio) had a chance to play. `CHANNEL_HANGUP_COMPLETE` arrives at T+0.4 s, before sched_transfer fires.

**Status**: Per §6.2, customer-hangup-early → conservative count as abandon. `safe_harbor_played=false`. Operator-visible in the "PDROP" bucket but with `drop_reason='customer_hangup_early'`.

---

## 7. The threshold pair — soft cap 2.5% / hard cap 3.0%

### 7.1 Why two thresholds

A single threshold (e.g., gate engages at 3.0%) is operationally hostile:
- The first 30-day window starts empty; small denominators mean even a single drop spikes the rate (1 drop / 30 answers = 3.3%, immediate gate)
- Adaptive dial-level engines (E03) oscillate around the threshold, flapping the gate
- Operators have no warning until the gate is already engaged
- Recovery is slow (a single drop's 30-day decay means the rate stays elevated for ~29 days even with zero new drops)

A two-tier design gives:
- **Early-warning (soft cap at 2.5%)**: Operator sees the rate climbing; can manually slow the campaign before the hard cap hits
- **Adaptive throttling (E03)**: Reading `drop_pct` directly, E03 lowers dial-level WHEN `drop_pct > soft_cap`; this happens before the gate engages
- **Hard cap at 3.0%**: Last-line defense; absolute regulatory ceiling

### 7.2 What happens at the soft cap

Soft cap exceeded (`drop_pct >= drop_target_soft AND drop_pct < drop_target_max`):
- **Operator page** (severity WARN, not PAGE). Pager-duty wakes the on-call.
- M03 admin dashboard turns the campaign row yellow.
- S01 wallboard shows red icon next to the campaign.
- E03 reads `drop_pct` and stops increasing the dial-level (E03's responsibility — outside E05).
- `drop_gated` STRING is **NOT** set. E02 doesn't clamp.
- New campaign metric `vici2_e05_drop_soft_cap_breached_seconds` increments.

### 7.3 What happens at the hard cap

Hard cap exceeded (`drop_pct >= drop_target_max`):
- **Operator page** (severity PAGE — wake them up).
- M03 admin dashboard turns the campaign row red.
- S01 wallboard shows alarm.
- `drop_gated=1` SET in Valkey (publish, then write).
- `drop_gate_engaged_at` SET with current timestamp.
- XADD `drop_gate_transitions` with `{action: engage, drop_pct, source: auto}`.
- E02 reads `drop_gated` on next pacing tick (≤1 s); clamps `desired=1`. Campaign collapses to PROGRESSIVE-1.0.
- E03 sees `drop_pct` and resets dial-level to 1.0 immediately (E03 owns).
- `vici2_e05_drop_hard_cap_breached_seconds` increments.
- Pubsub broadcast `t:{tid}:broadcast:campaign:{cid}` with `{event: drop_gated, drop_pct, ts}` for live wallboard.

### 7.4 Why 2.5% soft / 3.0% hard

- The 3.0% hard cap is fixed by 47 CFR § 64.1200(a)(7). Not configurable upward; per-campaign can be configured DOWNWARD (regulated industries — see §7.6).
- The 2.5% soft cap is a 0.5%-margin warning. Industry [4][6][14] uses 0.5–1.0% margins. 0.5% is the most aggressive (catches breaches close to the line); 1.0% (i.e., soft cap at 2.0%) gives more warning time. We default to 0.5% margin and let operators tune.
- Default for new campaigns: `drop_target_soft=2.50`, `drop_target_max=3.00`. M03 admin UI exposes both.

### 7.5 Recommended production defaults

Per DESIGN.md §1.2 key knobs: `adaptive_dropped_percentage default 3.0; recommend 1.5`. The DESIGN doc recommends 1.5% as the day-to-day hard cap, leaving 1.5% safety margin under FCC.

We ratify: **default `drop_target_max=1.50`** for new campaigns (matches DESIGN.md). `drop_target_soft=1.00`. Both per-campaign override-able up to 3.0% / 2.5%. NEVER allow `drop_target_max > 3.00` (CI check, F02 schema CHECK constraint).

### 7.6 Regulated-industry override (DOWNWARD only)

Some campaigns (healthcare, financial services) have stricter abandonment rules from state attorneys-general or industry self-regulation. Operator-set: `drop_target_max_override=1.00` (or anything ≤ 3.0%). Validation: `drop_target_max_override <= drop_target_max`. Phase 2 ships with the column nullable.

### 7.7 Why not single threshold at 2.0%

Some shops do this: skip the soft/hard distinction, just gate at 2.0%. Why we don't:
- Operators want forewarning (the soft cap is a "we're heading for trouble" signal that lets them call a meeting)
- A two-tier system creates a "yellow zone" where the campaign is slowing but not throttled, useful for tuning
- The cost is one additional config knob (`drop_target_soft`) which has a sensible default

### 7.8 Threshold validation at runtime

E05 startup + on `campaigns` config-change pubsub:

```
assert drop_target_soft <= drop_target_max
assert drop_target_max <= 3.0
assert drop_target_max > 0
if drop_target_max_override is set:
    assert drop_target_max_override <= drop_target_max
    drop_target_max_effective = drop_target_max_override
else:
    drop_target_max_effective = drop_target_max
```

Invalid config: refuse to start the campaign + alert admin. The admin UI prevents these states at save-time, but defense-in-depth.

---

## 8. Per-campaign isolation guarantees

### 8.1 The FCC's "single calling campaign" definition

47 CFR § 64.1200 doesn't define "campaign" directly; it cross-references 16 CFR § 310 (FTC TSR) which defines a "campaign" as:

> "An ongoing effort, by or on behalf of a particular seller, to induce the purchase of a particular good or service" (16 CFR § 310.2(d))

In vici2's data model: one `campaigns` row = one FCC campaign (cite F02 PLAN §4.6). The `(tenant_id, campaign_id)` composite primary key is the FCC-campaign identity.

### 8.2 What "per-campaign" means in practice

- Drop rate is computed per `(tenant_id, campaign_id)`. Never aggregated.
- A breach in campaign A does NOT affect campaign B (even within the same tenant). They're separate FCC campaigns.
- Reporting per campaign in M08. No tenant-wide "total drop rate" because that's not a regulated number.

### 8.3 What "campaign reorganization" looks like

If admin renames a campaign or splits one campaign into two (M03 admin action): the 30-day window for the new campaign starts at zero. The old `(tenant_id, old_campaign_id)` row sits in `campaigns` (and its `drop_log` rows persist), but no new dials happen on it.

There's a defensive case where an admin might try to "reset" a campaign that's gated by renaming it — clearly a TCPA-evasion attempt. Mitigation: M03 admin audit log captures all campaign rename operations; M08 reports flag any rename that occurred during a `drop_gated` state. C03 (audit log immutability) ensures the trail.

### 8.4 List-level isolation: not regulated

Some operators want "per-list drop rate" (a different list of leads might have different audience characteristics). FCC doesn't require this and doesn't regulate at the list level. We support **reporting** per-list (M08 query: `GROUP BY campaign_id, list_id`) but the **gate** is per-campaign only.

### 8.5 Phase 4 multi-tenant SaaS isolation

In SaaS mode, tenants share infrastructure but never share drop rate state. Each tenant's `(tenant_id, campaign_id)` is independent; one tenant's gated campaign doesn't affect another tenant's campaigns. The Valkey key prefix `t:{tid}:` enforces this at the key level; MySQL row-level enforced by `tenant_id`.

If a SaaS provider operates a campaign on behalf of multiple sellers (the "service bureau" case) — that's a single FCC campaign per seller, even if the service bureau aggregates them. Our model: each seller gets a separate `campaigns` row. Service bureau is out of scope for Phase 4.

---

## 9. Recovery — releasing the gate

### 9.1 Naive recovery is wrong

```
if drop_pct < drop_target_max:
    drop_gated = absent
```

Why bad:
- The 30-day window has ~30 days of inertia. A single high day shifts `drop_pct` and locks the gate for weeks.
- Once locked, the only way to lower `drop_pct` is to make more live-answered calls (numerator stays fixed; denominator grows). But the gate prevents pacing → fewer calls → denominator doesn't grow → gate doesn't release. Deadlock.
- Even when `drop_pct` does dip below threshold, a single drop on the next call (which IS allowed under `desired=1`) can push it back over. Flapping.

### 9.2 Hysteresis (the band-gap trick)

```
engage_threshold = drop_target_max         # 3.0% default
release_threshold = drop_target_max - 1.0  # 2.0% default

if drop_gated and drop_pct < release_threshold:
    consider release  (subject to dwell — see §9.3)
if not drop_gated and drop_pct >= engage_threshold:
    engage immediately
```

The 1.0 percentage-point band absorbs noise. With `drop_target_max=3.0`, the gate doesn't release until rate falls to 2.0% — typically requires the bad day to age out of the 30-day window.

### 9.3 Dwell-time enforcement

Even at `drop_pct < release_threshold`, the gate stays for `recover_seconds` (default 300 s = 5 min). Why:
- Prevents flapping when `drop_pct` is at the release boundary
- Gives operator time to investigate the breach (5 min is enough to log in and look)
- Models the regulatory intent: "you had a problem; you should be cautious"

Configurable per-campaign. Default 300 s. Validators: `recover_seconds >= 60` (to prevent instant-release misconfigurations).

### 9.4 Manual operator release

Operator can `POST /api/admin/campaigns/:cid/drop-gate/release` to force-release before dwell elapses. Audit-logged with operator user_id + reason text. Requires `campaigns:override_drop_gate` RBAC permission (F05 enforces).

Use case: operator investigated the breach, found it was a transient (e.g., a single network blip caused 5 PDROPs), and wants to restart the campaign. Force-release skips the dwell.

The release is recorded in `drop_gate_transitions` STREAM with `source: operator`. Reportable in M08.

### 9.5 State machine (engaged ↔ released)

```
states: NORMAL, SOFT_BREACH, HARD_BREACH

transitions:
  NORMAL --(drop_pct >= drop_target_soft)--> SOFT_BREACH       [page WARN, no gate]
  NORMAL --(drop_pct >= drop_target_max)--> HARD_BREACH        [page PAGE, gate on]
  SOFT_BREACH --(drop_pct >= drop_target_max)--> HARD_BREACH   [page PAGE, gate on]
  SOFT_BREACH --(drop_pct < drop_target_soft - 0.5)--> NORMAL  [clear warning]
  HARD_BREACH --(drop_pct < release_threshold)--AND (dwell elapsed)--> ... 
    --> NORMAL if drop_pct < drop_target_soft - 0.5            [gate off]
    --> SOFT_BREACH if still ≥ drop_target_soft                [gate off, but still warned]
  HARD_BREACH --(operator override)--> NORMAL                  [audit-logged, dwell bypassed]
```

Drop_target_soft hysteresis (similar 0.5 pp band) prevents soft-cap flapping.

### 9.6 Recovery scenarios

**Scenario 1: Brief breach**. A spike caused `drop_pct` to hit 3.1% for 5 minutes. After the spike, drops stop arriving. Within 60 s, `drop_pct` falls back below 2.0% (denominator-driven recovery — more live-answers added; numerator unchanged). Wait 300 s dwell. Release. Total downtime: ~6 minutes.

**Scenario 2: Sustained breach**. The drop rate is genuinely high (e.g., agent shortage). `drop_pct` stays above 2.0% for hours. The gate stays engaged the whole time. E02 pacing is throttled. Operator must investigate (more agents, slower campaign).

**Scenario 3: Aged-out breach**. The breach happened 28 days ago. As that data ages out of the 30-day window, `drop_pct` slowly declines. Eventually crosses 2.0%; dwell starts; releases. The operator can also manually force-release once they're sure the underlying issue is resolved.

### 9.7 The "first 30 days" small-denominator problem

A brand-new campaign starts with denominator=0. The first live-answered call increments denominator to 1. The first drop sends `drop_pct` to 100%. The gate engages immediately.

Mitigations (already common practice):
- **Minimum-denominator floor**: don't compute `drop_pct` until denominator >= 100. Before then, assume 0% (safer than chaos).
- **Per-campaign warmup window**: M03 admin can set `drop_warmup_completed_at` (operator-managed) — until that timestamp, drop-gate logic is paused; only logging happens.

Default Phase 2 behavior: **floor at denominator=100**. Configurable per-campaign.

### 9.8 What "release" looks like end-to-end

E05's 15-s ticker, on a release event:

```
DEL t:{tid}:campaign:{cid}:drop_gated
XADD t:{tid}:campaign:{cid}:drop_gate_transitions {action: release, drop_pct, source: auto, ts}
PUBLISH t:{tid}:broadcast:campaign:{cid} {event: drop_gate_released, ts}
prom.vici2_e05_drop_gate_released_total{cid, source}.inc()
log: "campaign {cid} drop gate RELEASED at drop_pct={x.xx}%; engaged for {duration}"
```

E02 reads the absence of `drop_gated` on the next tick and resumes normal pacing.

---

## 10. Audit + evidence (7-year retention; TCPA discovery)

### 10.1 What evidence we keep

Per TCPA discovery practice [9][12][16]:

| Evidence | Source | Retention | Purpose |
|---|---|---|---|
| `drop_log` rows | E05 INSERTs | 7 years (C04 owns) | "Every abandoned call between dates X and Y" |
| `call_log.is_drop=true` | E05 UPDATEs | 7 years (C04 owns) | "Every CDR with is_drop flag" |
| `recording_log` rows (if recording on) | R01 INSERTs at recording start | 7 years (C04 owns) | "The audio of the abandon" |
| Recording WAV files | R01 / S3 | 7 years (C04 + S3 lifecycle) | "Hear the safe-harbor audio play" |
| `originate_audit` rows | T04 INSERTs | 7 years (C04 owns) | "The upstream attempt that became this drop" |
| `drop_gate_transitions` STREAM | E05 XADDs | 7 years exported to MySQL (Phase 3 — F02 amendment for `drop_gate_transition_log` table) | "When did the gate engage and release?" |
| `campaigns` config snapshots | C03 audit_log | 7 years | "What was the threshold at the time?" |

All keyed on `attempt_uuid` / `call_uuid` (the same string per T04's one-UUID rule).

### 10.2 The discovery scenario

A serial-plaintiff lawyer files a TCPA suit, alleging the customer received a call without proper consent. Discovery demands:

> "Produce all records of telephone calls to [phone number] between [date X] and [date Y], including but not limited to: (a) any abandoned calls; (b) any calls answered by a person but not connected to a sales representative within two seconds; (c) the recordings of any such calls; (d) the campaign's abandonment rate during the relevant period; (e) the dial level configuration at the time."

Our response, via M08 reports:

- (a) `SELECT * FROM drop_log WHERE phone_e164=? AND dropped_at BETWEEN ? AND ?`
- (b) Same query — that's the definition of `drop_log`
- (c) `SELECT * FROM recording_log r JOIN drop_log d ON r.call_log_id=d.call_log_id WHERE d.phone_e164=? AND d.dropped_at BETWEEN ? AND ?` — produce WAV files from S3
- (d) `SELECT campaign_id, COUNT(*) AS drops, ... AS denominator, drops/denominator AS rate FROM call_log c JOIN statuses s ON ... WHERE ...` — the M08 TCPA report
- (e) `SELECT * FROM campaigns_audit WHERE campaign_id=? AND changed_at BETWEEN ?` from C03 — config snapshots

Total response time: <2 hours per the LRS [9] requirements for litigation hold compliance.

### 10.3 What constitutes "proper" safe-harbor evidence

Per cite [4][9]:

> "An operator claiming the safe-harbor exemption must produce, for each abandoned call: (i) proof that the recording played; (ii) the content of the recording; (iii) the system configuration enforcing the 3% cap; (iv) the rolling-window calculation showing < 3%."

Our coverage:
- (i) `drop_log.safe_harbor_played=true` + `recording_log` row showing the audio file UUID
- (ii) The WAV file content on S3 + the M02 admin UI's "audio file uploaded by" audit trail
- (iii) `campaigns.adaptive_drop_pct` (or `drop_target_max`) + the F02 schema CHECK constraint + the M08 TCPA report
- (iv) M08 report query (above)

### 10.4 Litigation hold (C04)

When a litigation hold is filed, C04 freezes partition drops for the affected `(tenant_id, campaign_id, date_range)` tuple. `drop_log` partitions older than 7 years are normally dropped via partition pruning; under litigation hold, they're retained.

E05 doesn't need special handling — it just keeps writing. The 7-year retention is C04's responsibility.

### 10.5 Right-to-delete tension

GDPR / CCPA right-to-delete: a customer requests deletion. Their `leads` row is deletable. But their `call_log` / `drop_log` rows are TCPA-evidence and CANNOT be deleted without breaking compliance.

Resolution (per C04 design): `drop_log` keeps `phone_e164` (it's the regulated identifier) but the lead linkage breaks; the phone number itself is the only PII retained. This is standard practice [16]; both the EU and California recognize regulatory retention exceptions.

Phase 2 ships with this behavior; M06 admin "delete lead" RBAC-restricted to admins; audit-logged.

### 10.6 No PII in metrics

Prometheus metrics + Grafana dashboards expose `drop_pct{tenant, campaign}` but NEVER `{phone_e164}`. PII in metrics is the #1 GDPR pitfall [16]. E05's metric labels are tested in CI to ensure no PII fields appear.

---

## 11. Reporting (operator dashboards + M08 reports)

### 11.1 Live dashboard (S01 wallboard)

For each campaign, S01 shows:

| Field | Source | Refresh |
|---|---|---|
| Current `drop_pct` | Valkey `t:{tid}:campaign:{cid}:drop_pct` | 1 Hz |
| Soft cap (configured) | `campaigns.drop_target_soft` | on config-change pubsub |
| Hard cap (configured) | `campaigns.drop_target_max` | same |
| State (NORMAL / SOFT_BREACH / HARD_BREACH) | derived from above | 1 Hz |
| Drops today | `SELECT COUNT(*) FROM drop_log WHERE ... AND dropped_at >= DATE(NOW())` | 10 s |
| Drops last 30 days | `drop_count_30d` STRING | 15 s |
| Denominator 30 days | `drop_denominator_30d` STRING | 15 s |
| Days-until-aging-out (worst-case oldest abandon) | derived from `MIN(dropped_at)` | 60 s |
| Projected hard-cap-breach ETA | extrapolated from EWMA trajectory | 60 s |

### 11.2 Projected breach ETA

"At current rate of drops, when will we hit the hard cap?"

```
recent_drop_rate = drops_last_hour / max(answers_last_hour, 1) * 100
if recent_drop_rate >= drop_target_max:
    "ALREADY BREACHED"
else:
    future_drops_per_hour = recent_drop_rate * (denominator_last_hour / answers_last_hour) * answers_per_hour  
    # ... assume continued at same rate
    # solve: (current_drops + t*future_drops_per_hour) / (current_denominator + t*future_answers_per_hour) = drop_target_max
    # gives t_breach in hours
```

This is operator-facing forecasting; not regulated. Useful for "stop the campaign before it gets bad" decisions.

### 11.3 Per-campaign TCPA report (M08)

A "TCPA Drop-Rate Compliance Report" per campaign per date range:

```
SELECT
  c.campaign_id,
  COUNT(DISTINCT c.id) AS calls_dialed,
  COUNT(DISTINCT CASE WHEN s.human_answered THEN c.id END) AS human_answered_total,
  COUNT(DISTINCT CASE WHEN c.is_drop THEN c.id END) AS drops_total,
  COUNT(DISTINCT CASE WHEN c.is_drop AND dl.safe_harbor_played THEN c.id END) AS drops_safe_harbor_played,
  COUNT(DISTINCT CASE WHEN c.is_drop AND NOT dl.safe_harbor_played THEN c.id END) AS drops_pdrop_no_audio,
  100.0 * COUNT(DISTINCT CASE WHEN c.is_drop THEN c.id END)
    / NULLIF(COUNT(DISTINCT CASE WHEN s.human_answered THEN c.id END), 0) AS drop_rate_pct,
  '3.00' AS fcc_hard_cap_pct
FROM call_log c
JOIN statuses s ON c.tenant_id=s.tenant_id AND c.status=s.status
LEFT JOIN drop_log dl ON dl.call_log_id=c.id
WHERE c.tenant_id=?
  AND c.campaign_id=?
  AND c.call_started BETWEEN ? AND ?
GROUP BY c.campaign_id;
```

Columns:
- `calls_dialed` — total CDRs (for context; not regulated)
- `human_answered_total` — the DENOMINATOR (the regulated number)
- `drops_total` — the NUMERATOR (the regulated number)
- `drops_safe_harbor_played` — covered by exemption
- `drops_pdrop_no_audio` — per-call violations (must be zero or near-zero)
- `drop_rate_pct` — the regulated rate
- `fcc_hard_cap_pct` — the regulatory ceiling for reference

The report exports as CSV for litigation production + PDF with the campaign's `drop_target_max` setting + the period's M03 audit trail.

### 11.4 Hourly intraday view

For ops monitoring (not regulatory), M08 also shows:

```
SELECT
  DATE_TRUNC('hour', c.call_started) AS hour,
  COUNT(DISTINCT CASE WHEN s.human_answered THEN c.id END) AS denominator,
  COUNT(DISTINCT CASE WHEN c.is_drop THEN c.id END) AS drops,
  100.0 * drops / NULLIF(denominator, 0) AS hourly_rate
FROM ... 
GROUP BY hour
ORDER BY hour;
```

Graphed as a time-series. Useful for "we had a bad afternoon — was it our agent scheduling?".

### 11.5 Cross-campaign comparison (operator)

For multi-campaign tenants, M08 lists all campaigns sorted by `drop_rate_pct` descending. Worst offenders at top. Useful for "where do I focus my agent allocation?".

### 11.6 Anomaly detection (Phase 3 candidate)

EWMA-based anomaly: alert if today's drop rate is 3σ above the 7-day rolling mean, even if absolute rate is below hard cap. Catches "something changed" issues before they become breaches. Not in Phase 2 scope.

---

## 12. Algorithms compared (drop-rate computation alternatives)

We evaluated several drop-rate algorithms.

### 12.1 Strict rolling 30-day window (our choice)

```
drop_pct(t) = drops_in_[t-30d, t] / live_answers_in_[t-30d, t] × 100
```

- **Pros**: directly maps to FCC text. No ambiguity in legal interpretation. Simple to explain.
- **Cons**: "old drops haunt you" — a bad day 28 days ago drives current rate even when current behavior is fine. Recovery is slow.
- **Implementation**: SQL `WHERE dropped_at >= NOW() - INTERVAL 30 DAY`. Stream `XRANGE` filtered by `ts`. Both straightforward.

**Recommended**. The FCC rule is explicit about a 30-day rolling window. Inventing a different averaging scheme risks discovery objections ("you didn't compute the rate the way the FCC said to compute it"). 

### 12.2 Exponential moving average (EWMA)

```
drop_pct(t) = α × instant_drop_rate + (1-α) × drop_pct(t-1)
```

- **Pros**: recent events weighted more; recovers faster.
- **Cons**: not what the FCC says. The 30-day window is rolling, not exponentially decaying. EWMA is informally useful for trend analysis but cannot be the regulatory rate.

**Not used as the regulated rate**. M08 may show EWMA as a complementary view (operator forecasting); the regulated rate is the strict rolling window.

### 12.3 Daily buckets + sum

```
For each day in last 30:
  buckets[day] = (drops_that_day, answers_that_day)
drop_pct = SUM(drops) / SUM(answers) over 30 buckets
```

- **Pros**: counter-based; no per-event storage; ~30 INCRs total.
- **Cons**: granular only at day-boundary; doesn't fall behind/catch up smoothly. Plus we want per-event audit trail.

**Not used as the primary** but the Phase 3 anomaly detection might use it for hourly-bucket comparisons.

### 12.4 Stream + nightly aggregate

```
Stream stores raw events (answer, drop)
Cron at midnight aggregates yesterday's day-bucket
Rolling rate = sum(buckets[yesterday-30 to yesterday]) + today's live count
```

- **Pros**: low storage, fast read
- **Cons**: complex (two systems); same drift risk as F04 reconciler

**Used implicitly** — F04's `XTRIM MINID <30d-ago>` is essentially a stream-trim, and we keep the raw events. We just don't aggregate to buckets; we re-scan the stream.

### 12.5 Token bucket / leaky bucket (not applicable)

Some adaptive dialer literature [14][15] uses token-bucket rate-limiting on the originate side, but for DROP-rate ENFORCEMENT, the bucket model doesn't fit: drops aren't "tokens being added"; they're external events.

### 12.6 Decision: Stream + MySQL aggregation, no EWMA in the regulated rate

Phase 2 ships option 12.1. Periodic recompute (every 15 s) from MySQL (authoritative) + Valkey STREAM (fast cache). EWMA optionally exposed for operator forecasting only.

---

## 13. Failure modes matrix

| # | Failure | Detection | E05 action | Metric | Severity |
|---|---|---|---|---|---|
| 1 | Drop event arrives but `drop_log` INSERT fails (DB down) | exception in handler | retry once with backoff; if still fails: write to Valkey "pending writes" list; alert | `vici2_e05_drop_log_write_failed_total` | PAGE |
| 2 | Drop event arrives but `call_log` UPDATE fails | exception | log + retry; eventual consistency via E06 sweep | `vici2_e05_call_log_update_failed_total` | WARN |
| 3 | Safe-harbor audio file missing at originate time | file-stat check at E02 startup | refuse to start pacer; alert admin via M03 | `vici2_e05_audio_missing_total{campaign}` | PAGE |
| 4 | Safe-harbor audio failed to play (mid-call) | dialplan error; `vici2_safe_harbor_played` absent on hangup | mark as PDROP; alert; pages on every occurrence | `vici2_e05_audio_play_failed_total` | PAGE |
| 5 | drop_window STREAM ↔ drop_log drift > 0.05% | reconciler at 60 s | warn; use MySQL as authoritative | `vici2_e05_stream_drift_pct` | WARN |
| 6 | drop_window STREAM ↔ drop_log drift > 1% | reconciler | freeze campaign (set drop_gated defensively); alert PAGE | `vici2_e05_stream_severe_drift_total` | PAGE |
| 7 | Valkey down during gate publish | F04 client error | retain in-memory state; retry; if persists >30 s, mark all campaigns as engaged (fail-closed) | `vici2_e05_valkey_unavailable_seconds` | PAGE |
| 8 | E02 doesn't honor drop_gated (bug in E02) | continued originates after gate engaged | E02 metric `vici2_dialer_pacing_clamp_total{clamp=drop}` rate | n/a (E02 owns) | PAGE — coordinate with E02 |
| 9 | denominator < 100 (warmup) | recompute check | floor `drop_pct=0`; log warning only | `vici2_e05_warmup_campaigns` | INFO |
| 10 | numerator > denominator (impossible state) | sanity check | log ERROR; use 99% as effective rate; alert | `vici2_e05_invariant_violation_total` | PAGE |
| 11 | sched_transfer fires after agent-bridge (race) | playback starts on bridged channel | dialplan guard: if `vici2_safe_harbor_cancelled`, no-op | `vici2_e05_late_audio_skipped_total` | INFO |
| 12 | Operator force-release abused (multiple force-releases per hour) | M03 audit log | alert security (audit-log review) | n/a (C03 owns) | WARN |
| 13 | Process crash mid-write | E06 janitor finds inconsistent state | replay from Valkey "pending writes"; reconcile with MySQL | `vici2_e05_crash_recovery_total` | INFO |
| 14 | Campaign deleted with active drop_log rows | M03 admin action | reject deletion; require operator to archive first | n/a | INFO |
| 15 | Threshold misconfiguration (`drop_target_max > 3.0`) | config validation at startup | refuse to start; alert admin | `vici2_e05_invalid_config_total` | PAGE |
| 16 | dial_method = MANUAL but drop tracking still configured | config validation | log INFO; skip ticker for this campaign | `vici2_e05_skipped_manual_campaigns` | INFO |

Every entry is observable via metric + log.

---

## 14. Performance + capacity

### 14.1 Read cost

- E02 read of `drop_gated` per pacing tick: 1 RESP3-cached EXISTS ≈ 0 µs (client cache) per tick × 50 campaigns × 1 Hz = ~0 ops/s aggregate. Free.
- E05 ticker read of `drop_pct` etc. per 15 s: ~6 STRING reads per campaign × 50 campaigns / 15 s = 20 ops/s. Negligible.

### 14.2 Write cost

- Per-abandon write burst: 1 INSERT (drop_log) + 1 UPDATE (call_log) + 0 XADD (T01 does it) + 0 STRING SET (15-s ticker). ~3-5 ms total. At 1% drop rate × 50 CPS = 0.5 abandons/s aggregate. ~2.5 ms/s of DB time. Trivial.
- E05 ticker write per 15 s: 4 STRING SETs + 0–1 STREAM XADD (only on transitions) × 50 campaigns / 15 s = ~13 ops/s. Free.

### 14.3 Storage

- `drop_log` per drop ~250 bytes. 1% drop × 50 CPS × 365 days = ~157 M rows × 250 B = ~40 GB/year for 50 campaigns. C04 7-year retention = 280 GB. Manageable.
- `drop_window` STREAM: 81 MB at 50 campaigns (per F04 estimate). Trivial.

### 14.4 Latency budget

- E05's safe-harbor terminator path adds zero latency to bridged calls (the sched_transfer never fires when bridge happens).
- Reporting query (M08): the 30-day aggregate scans ~150 K rows per campaign in the partition. Indexed properly: ~50 ms. Fine for on-demand reports.

### 14.5 Scaling beyond 50 campaigns

The math scales linearly with campaign count. At 500 campaigns:
- Reads: still negligible
- Writes: 5× more drops/s; still <50 IOPS
- Storage: 5× drop_log rows; 200 GB/year per tenant; ~1.4 TB at 7 years. Plan F02 archive strategy.
- Reporting queries: same per-campaign cost; tenant-wide reports scale linearly.

### 14.6 Multi-FS scaling

E05 has one logical instance per tenant (or per pod with leader-election). Multiple FS hosts (X02 Kamailio dispatcher) don't affect E05 — abandon events still flow through one Valkey + one MySQL per tenant. Drop tracking is FS-host-agnostic.

---

## 15. Observability + metrics

Prometheus metrics (Phase 2 ship):

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_e05_drop_rate_pct` | gauge | `{tenant, campaign}` | Live drop rate (the regulated number) |
| `vici2_e05_drop_count_30d` | gauge | `{tenant, campaign}` | Numerator |
| `vici2_e05_drop_denominator_30d` | gauge | `{tenant, campaign}` | Denominator |
| `vici2_e05_drop_gate_engaged` | gauge (0/1) | `{tenant, campaign}` | Current gate state |
| `vici2_e05_drop_gate_engagements_total` | counter | `{tenant, campaign, source}` | source = `auto` / `operator_force` |
| `vici2_e05_drop_gate_releases_total` | counter | same | same |
| `vici2_e05_drop_gate_seconds_engaged_total` | counter | `{tenant, campaign}` | cumulative gated time |
| `vici2_e05_drop_soft_cap_breached_seconds` | counter | same | soft-cap exposure |
| `vici2_e05_drop_hard_cap_breached_seconds` | counter | same | hard-cap exposure |
| `vici2_e05_drops_total` | counter | `{tenant, campaign, drop_reason, safe_harbor_played}` | per-drop classification |
| `vici2_e05_pdrop_total` | counter | `{tenant, campaign, reason}` | PDROP (no audio) — separate; should be near zero |
| `vici2_e05_safe_harbor_audio_play_failed_total` | counter | `{tenant, campaign}` | PAGE on rate > 0 |
| `vici2_e05_stream_drift_pct` | gauge | `{tenant, campaign}` | reconciler drift |
| `vici2_e05_stream_severe_drift_total` | counter | `{tenant, campaign}` | drift > 1% |
| `vici2_e05_ticker_duration_seconds` | histogram | `{tenant}` | 15-s ticker latency |
| `vici2_e05_reconciler_duration_seconds` | histogram | `{tenant}` | 60-s reconciler latency |
| `vici2_e05_drop_log_write_latency_seconds` | histogram | `{tenant}` | per-drop write hot path |
| `vici2_e05_invalid_config_total` | counter | `{tenant, campaign, reason}` | threshold misconfig |
| `vici2_e05_warmup_campaigns` | gauge | `{tenant}` | campaigns < 100 denominator |

Alerts:
- PAGE: `drop_gate_engaged{}=1` for any campaign (operator must investigate).
- PAGE: `pdrop_total` rate > 1/hour (safe-harbor audio failing).
- PAGE: `safe_harbor_audio_play_failed_total` rate > 0 (PER-CALL violation).
- PAGE: `stream_severe_drift_total` rate > 0 (reconciler red).
- WARN: `drop_soft_cap_breached_seconds` rate > 60/min (sustained soft-cap).
- WARN: `valkey_unavailable_seconds` rate > 5/min.
- INFO: `warmup_campaigns` > 0 (cold-start visibility).

Grafana dashboard (O01 owned): per-campaign panel with `drop_rate_pct` line graph, gate state overlay, numerator/denominator over time, and a hard-cap reference line at 3.0%.

---

## 16. Open questions for PLAN

1. **Where does the 2-second timer live?** Dialplan `sched_transfer` (our recommendation) vs Go answer-handler goroutine vs hybrid. RESEARCH §4.1 picks dialplan; PLAN must ratify.

2. **F02 amendment scope.** PLAN must propose the following F02 amendment columns (one migration: `f02_e05_thresholds.sql`):
   - `campaigns.drop_target_soft DECIMAL(4,2) DEFAULT 1.00` (soft cap)
   - `campaigns.drop_target_max_override DECIMAL(4,2) NULL` (downward-only override, ≤ `drop_target_max`)
   - `campaigns.recover_seconds INT DEFAULT 300`
   - `campaigns.count_early_customer_hangup_as_drop BOOLEAN DEFAULT TRUE`
   - `drop_log.originator_attempt_uuid VARCHAR(40)` (forward link to originate_audit)
   - Extend `DropReason` enum to include `customer_hangup_early`, `audio_missing`, `software_error`
   - `drop_gate_transition_log` table (partitioned, mirrors STREAM)
   - CHECK constraint: `adaptive_drop_pct <= 3.00 AND drop_target_soft <= adaptive_drop_pct`
   - **Rename `adaptive_drop_pct` to `drop_target_max`** for clarity (alias supported for one minor version)

3. **Soft-cap action.** Just page operator (E05 only), or also slow E03 dial-level (E03 reads `drop_pct` itself)? RESEARCH §7.2 picks operator-page only; PLAN must ratify.

4. **Counting policy for customer-early-hangup.** Conservative (count it, our default) vs lenient (don't count). PLAN must pin the default + document the operator-override path.

5. **Safe-harbor audio precondition.** Refuse to start auto-dial campaign without `safe_harbor_audio`? RESEARCH §3.5 says YES; PLAN must wire into M03 admin + E02 startup + T04 originate-time gate.

6. **Cross-cutting "audio missing" alert SLA.** Per-call PAGE on every `safe_harbor_audio_play_failed_total`? RESEARCH §15 says yes; PLAN should propose a deduplication policy (otherwise a campaign-config bug spams 1000 pages/hour).

7. **Reconciler drift tolerance.** 0.05% is our pick (RESEARCH §5.7). What's the right number? Modeling: at 50 CPS × 1% drop × 30 days, denominator ~13M, numerator ~130K, 0.05% drift on 130K = ~65 calls disagreement. Acceptable. PLAN may want to tune.

8. **Operator override RBAC.** F05 permission name (`campaigns:override_drop_gate`)? Default to admin role only. PLAN must pin.

9. **Warmup denominator floor.** 100 calls (our pick) vs lower (50) vs higher (1000)? Modeling: at 1% drop rate, 100 answered = 1 drop = noisy rate (could be 0% or 100% depending on day). 1000 answered = 10 drops = stable. 100 is operator-friendly (campaign starts producing real rates within an hour at moderate CPS). PLAN should pin.

10. **State machine implementation.** In-process Go state machine vs Valkey-driven (Lua script that atomically tracks last-transition-time)? RESEARCH §9.5 sketches the FSM; PLAN must pick the implementation pattern.

11. **Reporting backfill.** When backfilling historical data (e.g., importing Vicidial CSV), how do we recompute drop_pct for historical campaigns? Phase 2 says "doesn't apply; new system". PLAN should document.

12. **Dual-tenancy across pods.** Phase 4: with multiple dialer pods, who owns the 15-s E05 ticker? Pick leader-election (per F04 PLAN pattern) or per-pod-per-campaign with race-style locking (matches E02's pattern). RESEARCH suggests race-style; PLAN must ratify.

13. **Gate transitions stream persistence.** Currently a Valkey STREAM (in-memory + AOF). Should we also export to MySQL `drop_gate_transition_log` for 7-year retention? RESEARCH §10.1 implies yes; PLAN must wire.

14. **Phase 1 vs Phase 2 readiness.** This module is Phase 2; T04 PLAN §3.2 has a "Phase 1 stubs ALLOW" placeholder for the originate-time drop-cap gate. When E05 ships, does T04 PLAN need a "wired" amendment? RESEARCH suggests yes — PLAN should coordinate with T04 PLAN owner.

---

## 17. Boundary table — what E05 owns, what others own

| Concern | Owner | E05's read or write |
|---|---|---|
| Pacing decisions (`desired` per tick) | E02 | E05 reads no E02 output; E05 PUBLISHES `drop_gated` STRING; E02 reads it |
| Dial-level adapt (raising/lowering level) | E03 | E03 reads E05's `drop_pct`; E05 writes the gauge; no API call |
| Agent picker (who answers) | E04 | E04 calls E05's `RecordDrop` when picker returns nil agent; E04 owns the picker |
| ESL transport (originate, hangup, transfer) | T01 | T01 writes `drop_window` STREAM (per F04 record_call_outcome.v1.lua); E05 reads + writes `drop_log` |
| Compliance pipeline (5 gates) | T04 | T04's `gateDropCap` reads `drop_pct`; E05 owns the gauge |
| TCPA window math | C01 | No interaction |
| DNC | D05 | No interaction |
| Recording (consent prompt, file storage) | C02, R01 | E05 reads `recording_log` for evidence; doesn't write |
| Recording retention | C04 | E05's drop_log inherits the retention policy |
| Status taxonomy | D04 | E05 reads `statuses.human_answered` for denominator |
| Live state in Valkey | F04 | F04 owns the helper lib; E05 uses it |
| Audit log immutability | C03 | E05 doesn't write audit_log; M03 admin actions do (force-release) |
| Reports | M08 | E05 publishes the data via MySQL + Valkey; M08 queries |
| Admin UI for thresholds | M03 | E05 reads `campaigns` thresholds; M03 owns config |
| Audio upload | M02 | E05 reads the path; M02 validates upload |
| Wallboard | S01 | E05 publishes via Valkey gauges + pubsub broadcast |
| Observability | O01 | E05 emits Prometheus metrics; O01 dashboards |

---

## 18. Worked examples

### 18.1 Example A — Healthy campaign

```
Tenant 1, Campaign SOLAR_Q2, dial_method=ADAPT_TAPERED
30-day window: 50,000 live-answered calls, 250 drops
drop_pct = 250 / 50000 * 100 = 0.50%
drop_target_soft = 1.00, drop_target_max = 1.50
State: NORMAL
drop_gated = absent
E02 paces normally
```

### 18.2 Example B — Soft-cap breach

```
... continuing
After a rough hour: 50,300 answered, 380 drops
drop_pct = 380 / 50300 * 100 = 0.755% → still below 1.00
... continuing more hours: 50,900 answered, 600 drops
drop_pct = 600 / 50900 * 100 = 1.18% → soft cap exceeded
State: SOFT_BREACH
- Page operator (WARN)
- M03 dashboard yellow
- E03 (independently) sees the rate and stops raising dial-level
- E02 paces normally (drop_gated still absent)
```

### 18.3 Example C — Hard-cap breach + recovery

```
... continuing further
51,400 answered, 800 drops
drop_pct = 800 / 51400 * 100 = 1.557% → hard cap exceeded
State: HARD_BREACH
- Page operator (PAGE)
- SET t:1:campaign:{SOLAR_Q2}:drop_gated 1
- SET t:1:campaign:{SOLAR_Q2}:drop_gate_engaged_at 2026-05-13T14:32:11Z
- XADD t:1:campaign:{SOLAR_Q2}:drop_gate_transitions {action: engage, drop_pct: 1.557, source: auto}
- PUBLISH t:1:broadcast:campaign:SOLAR_Q2 {event: drop_gate_engaged}
- E02 reads `drop_gated=1` on next tick (≤1 s); clamps desired=1
- E03 sees `drop_pct >= drop_target_max`; resets dial-level to 1.0

15 minutes later: drops have stopped (because pacing is throttled)
51,700 answered, 800 drops  (denominator grew, numerator unchanged)
drop_pct = 800 / 51700 * 100 = 1.547% → still above release_threshold (drop_target_max - 1.0 = 0.50)
State: HARD_BREACH (still engaged)

Several hours later, with denominator at 53,000:
drop_pct = 800 / 53000 * 100 = 1.509% → still above 1.50 ish
Drops continue to age out of 30-day window slowly...

Day later: oldest drops aging out:
denominator 53,500, numerator 750
drop_pct = 1.40% → still above release_threshold? release_threshold = 0.50. So 1.40% is above.

In our example with drop_target_max=1.50: release_threshold = max(drop_target_max - 1.0, 0) = 0.50.
But that's too aggressive — recovery would take weeks.
For drop_target_max=1.50, recommended release_threshold = drop_target_max - 0.50 = 1.00.
So when drop_pct < 1.00, gate may release (subject to dwell).

The hysteresis band is configurable; PLAN should propose:
release_threshold = drop_target_max - drop_target_hysteresis_pp
Where drop_target_hysteresis_pp defaults to:
- 1.0 pp if drop_target_max >= 2.0
- 0.5 pp if drop_target_max < 2.0
(absolute floor of release_threshold at 0.1%, so we don't get negative)
```

(Note: example illustrates why the PLAN's hysteresis math needs careful work.)

### 18.4 Example D — PDROP (operator alert)

```
At 14:32:05.123, customer answered.
E04 picker fired; pick_agent_for_call.v1.lua returned nil (no READY agent — race condition).
Go panic in E04's error handler — recover()'d but no further action.
At 14:32:07.123, sched_transfer fires.
Dialplan jumps to safe_harbor extension.
playback /var/lib/freeswitch/sounds/custom/safe_harbor/SOLAR_Q2.wav
→ PlaybackError: "file_not_found"
Channel proceeds to hangup.
CHANNEL_HANGUP_COMPLETE fires with hangup_cause=NORMAL_CLEARING
  but vici2_safe_harbor_played channel-var is ABSENT.

E05's ESL handler:
- INSERT drop_log {drop_reason: 'audio_missing', safe_harbor_played: false}
- UPDATE call_log SET is_drop=true, status='PDROP'
- XADD drop_window {answered=1, dropped=1}
- ALERT PAGE: "PDROP - audio missing for campaign SOLAR_Q2"
- metric: vici2_e05_safe_harbor_audio_play_failed_total{campaign=SOLAR_Q2}.inc()
- metric: vici2_e05_pdrop_total{campaign=SOLAR_Q2, reason=audio_missing}.inc()
```

Operator wakes up, investigates, finds the audio file was deleted by a misconfigured cleanup cron. Restores; opens M03 admin and confirms; force-releases drop_gate if needed.

### 18.5 Example E — Operator force-release

```
Drop gate engaged for SOLAR_Q2 at drop_pct=1.57%. After 30 minutes:
- denominator grew to 52,000
- drops still 800
- drop_pct = 1.538% — still above release_threshold of 1.00%

Operator clicks "Force Release" in M03:
- M03 calls POST /api/admin/campaigns/SOLAR_Q2/drop-gate/release { reason: "investigation complete; manual restart" }
- F05 RBAC checks: user has campaigns:override_drop_gate. OK.
- C03 audit_log INSERT.
- E05's handler:
  - DEL t:1:campaign:{SOLAR_Q2}:drop_gated
  - XADD drop_gate_transitions {action: release, drop_pct: 1.538, source: operator, user_id: 7, reason: "..."}
  - PUBLISH t:1:broadcast:campaign:SOLAR_Q2 {event: drop_gate_released}
  - metric: vici2_e05_drop_gate_releases_total{source=operator_force}.inc()

E02 reads drop_gated absent on next tick; resumes normal pacing.
```

---

## 19. Citations

1. **47 CFR § 64.1200 — Delivery restrictions** (Code of Federal Regulations). https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200 — authoritative text for the 3% abandonment ceiling, 30-day rolling window, safe-harbor recorded-message rule, 4-ring minimum.

2. **FCC 03-153 — Rules and Regulations Implementing the Telephone Consumer Protection Act of 1991** (2003 Order). https://www.fcc.gov/document/rules-and-regulations-implementing-telephone-consumer-protection-act-1991 — the original 3%/30-day rule.

3. **FCC 12-21 — Rules Implementing the TCPA / Robocalls** (2012 Order). https://www.federalregister.gov/documents/2012/06/11/2012-13862/telephone-consumer-protection-act-of-1991 — extended to wireless with prior express written consent.

4. **DNC.com — Understanding Abandoned Call Rules Under the TCPA** (industry walkthrough). https://www.dnc.com/blog/tcpa-tools-necessary-for-compliance-0-0 — annotated explanation of the 3% calculation, "campaign" definition, recorded-message rule.

5. **DNC.com FAQ — Is there call abandonment safe harbor?** https://www.dnc.com/faq/there-call-abandonment-safe-harbor — additional safe-harbor edge cases.

6. **SIPNEX — Abandoned Call Rate: FCC 3% Rule Explained**. https://www.sipnex.ca/blog/abandoned-call-rate-fcc-rules — call-center-ops-oriented 3% rule explainer (referenced in DESIGN.md §1.2).

7. **16 CFR § 310.4 — Abusive telemarketing acts or practices** (FTC TSR). https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.4 — FTC parallel rule (3% / 30-day / 2-second).

8. **FCC — Telephone Consumer Protection Act page**. https://www.fcc.gov/general/telephone-consumer-protection-act-1991 — official FCC TCPA portal.

9. **Litigator Risk Solutions — TCPA Discovery and Documentation Standards** (industry vendor whitepaper). https://www.litigatorriskservices.com/tcpa-discovery — typical discovery scope, evidence retention recommendations.

10. **FCC 21-3 — Call Blocking Safe Harbor (2021 Order)**. https://docs.fcc.gov/public/attachments/FCC-20-187A1.pdf — adjacent to E05; STIR/SHAKEN. Cited in DESIGN.md.

11. **Vicidial Forum — "How is the 2 second window measured?"** (community thread). http://www.vicidial.org/VICIDIALforum/viewtopic.php?t=37918 — practical "from CHANNEL_ANSWER" implementation.

12. **CompliancePoint — TCPA Compliance Best Practices** (industry consultancy). https://www.compliancepoint.com/articles/tcpa-compliance-best-practices/ — record retention guidance.

13. **Vicidial-forum recurring thread — "Drop rate seems too high"** (anecdotal but representative). http://www.vicidial.org/VICIDIALforum/viewforum.php?f=4 — confirms many implementations get the denominator wrong (using all dials instead of human-answered).

14. **Vicidial source — AST_VDauto_dial.pl / AST_VDadapt.pl** (open-source reference). https://github.com/Eflexicon/Vicidial/blob/master/bin/AST_VDauto_dial.pl — concrete reference implementation of the abandonment-window math.

15. **Talkdesk — How Predictive Dialers Work** (vendor docs). https://www.talkdesk.com/blog/how-predictive-dialers-work/ — vendor view of abandonment-rate management.

16. **TCPAWorld — FCC adopts new TCPA rules on consent revocation (2024)**. https://tcpaworld.com/2024/02/15/fcc-adopts-new-tcpa-rules-on-consent-revocation/ — most recent rulemaking; affects D05, peripherally E05.

17. **TCPAWorld — TCPA Statute of Limitations** (compendium of state SoL). https://tcpaworld.com/category/statute-of-limitations/ — 4 years federal + state variations; informs 7-year retention.

18. **Five9 — Predictive Dialer overview** (vendor docs). https://www.five9.com/products/predictive-dialer — vendor view of "advanced algorithms predict agent availability".

19. **FCC Enforcement Bureau — Notice of Apparent Liability cases** (sample TCPA enforcement). https://www.fcc.gov/enforcement — typical fines for § 64.1200(a)(7) breaches.

20. **TCPAWorld — Predictive Dialer Settlements** (litigation summaries). https://tcpaworld.com/category/predictive-dialer/ — case law showing per-call statutory damages.

21. **CompliancePoint — Beginner's Guide to the TCPA**. https://www.compliancepoint.com/articles/beginners-guide-to-the-tcpa/ — entry-level TCPA practitioner intro.

22. **DESIGN.md §1.2, §6.3, §6.4, §10.2** — local — modes table, dialTick + adaptive engine pseudocode, key knobs (`adaptive_drop_pct=1.5`).

23. **F02 schema** — `/root/vici2/api/prisma/schema.prisma` — model `DropLog`, `CallLog`, `Campaign`, `Status`.

24. **F04 PLAN** — `/root/vici2/spec/modules/F04/PLAN.md` §4.3 (`drop_window` STREAM), §6.3 (`record_call_outcome.v1.lua`), §4.7 (hash tags), §4.10 (events streams).

25. **D04 RESEARCH** — `/root/vici2/spec/modules/D04/RESEARCH.md` §3.2 (35-status seed; `human_answered` flag), §11.2 (DROP / PDROP semantics), §10 (3% drop rate denominator = `count(humanAnswered=true)`).

26. **E02 RESEARCH** — `/root/vici2/spec/modules/E02/RESEARCH.md` §3.4 (`drop_gate_clamp` reading `drop_gated`), §4.4 (drop_gate Valkey EXISTS read), §12.1 (FCC 3% ceiling hooks).

27. **T04 PLAN** — `/root/vici2/spec/modules/T04/PLAN.md` §3.2 (drop-cap gate stub for Phase 1; E05 wires later), §3 (5-gate pipeline order), §10 (typed errors including `ErrDropCap`).

28. **47 CFR § 64.1601 — Delivery restrictions (caller ID)** — adjacent; not E05.

29. **16 CFR § 310.2(d) — definition of "campaign"** (FTC TSR). https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.2 — "single calling campaign" definition.

30. **DESIGN.md §17** — local — recurring footguns including "SALE → NEW" admin-only path; touches drop-rate manipulation prevention.

# D04 — Status & Disposition Definitions — RESEARCH

| Field | Value |
|---|---|
| Module | D04 (the canonical status taxonomy for leads + calls) |
| Phase | 1 (MVP / manual-dial center) |
| Owner agent type | backend-node |
| Status | RESEARCH (PLAN unblocked once F02 schema FREEZE is observed — the `statuses` model + `campaign_status_overrides` table are already landed per the F02 amendments header in `api/prisma/schema.prisma` §4.9 / §E01.16 / §T04.2) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/D04.md` (3.6KB skeleton — interface stubs only; this RESEARCH supersedes the spec wherever they collide and pins the canonical 35-status default seed) |
| Related modules read | F02 (`statuses` model + `campaign_status_overrides` table — both landed via amendments A1/E01.16/T04.2); E01 PLAN §10/§12 (`dial_statuses` filter, recycle_delay JOIN, `campaign_status_overrides` override semantics); T04 PLAN §3.x (`D04Status()` typed-error hint, 4 new system statuses `TCPA` / `CONSENT_NOT_OBTAINED` / `CARRIER_FAIL` / `GATEWAY_LIMIT_TRY_LATER`); D01 PLAN §14.4 (`lead.status_changed` event — D04 owns); D06 spec stub (callback recycle); A06 spec stub (hotkey UI) |

---

## 1. Executive summary (10 bullets)

1. **D04 is the canonical status taxonomy** — a thin Node service over the F02 `statuses` table plus a deterministic FreeSWITCH `hangup_cause → status` mapper. The table is already in `api/prisma/schema.prisma` (model `Status`, lines 453-474) with composite PK `(tenant_id, campaign_id, status)` and the `__SYS__` sentinel campaign for system rows. **No schema work is required in D04** — every column the spec needs already exists (`selectable`, `human_answered`, `sale`, `dnc`, `callback`, `not_interested`, `hotkey`, `description`); the missing-in-schema piece is `recycle_delay_seconds`, which E01 PLAN §12 Q14 explicitly assigned to D04 and which we must add via a D04 schema amendment (see §4). Everything else is service-layer code: ~600 LOC TypeScript service + Zod validators + REST handlers + the hangup mapper + tests. **D04 owns the seed JSON** (`db/seeds/system-statuses.json`); F02 owns the table.

2. **The canonical default seed is 35 statuses across 6 categories.** (i) **Agent-selectable terminal** (8): `SALE`, `NI`, `NP`, `DEC`, `WRONG`, `DEAD`, `XFER`, `LM`. (ii) **Agent-selectable retryable** (5): `B`, `NA`, `N`, `DC`, `CALLBK`. (iii) **Agent-selectable compliance** (1): `DNC`. (iv) **System answered** (4): `A` (AMD machine), `AA` (carrier-detected machine), `AFAX` (fax), `AVMA` (AMD voicemail beep detected). (v) **System unanswered / carrier failure** (8): `B-CAR` (carrier busy), `NA-CAR` (carrier no-answer), `ADC` (carrier disconnect), `INVALID` (UNALLOCATED_NUMBER), `TIMEOT` (ring timeout), `CARRIER_FAIL` (gateway down — T04.2 seed), `GATEWAY_LIMIT_TRY_LATER` (concurrent cap — T04.2 seed), `MEDIA_TO` (media timeout). (vi) **System compliance / lifecycle** (9): `NEW` (uncalled), `QUEUE` (hopper-in-flight), `INCALL` (live with agent), `DROP` (abandon — counts vs 3% safe harbor), `PDROP` (pre-route drop), `TCPA` (TCPA blackout — T04.2 seed), `CONSENT_NOT_OBTAINED` (state consent gate blocked — T04.2 seed), `ERI` (agent error / browser closed before disposition), `CBHOLD` (callback waiting for trigger time). Full table with all 8 flag columns in §3.

3. **System vs selectable is the dominant invariant.** Statuses with `selectable=false` cannot appear in A06's disposition picker; they are originated/written only by the system (T04 on a hangup_cause map; E01 on a TZ blackout; E05 on a 2-second-no-agent abandon; D06 on a callback trigger; T01 on a media timeout). Statuses with `selectable=true` are eligible for the agent dropdown **subject to** the per-campaign `dial_statuses` JSON whitelist (which is actually the `selectable_for_agent` filter — see §6) **and** the per-campaign `campaign_status_overrides.selectable` override. **System statuses are immutable** at the API surface: `PATCH /statuses/:code` with `campaign_id='__SYS__'` returns `403 system_status_immutable`. Tenants can shadow a system status by inserting a per-campaign row with the same `status` code but different flags — UPSERT semantics described in §5.4.

4. **The `__SYS__` sentinel design is correct and is the established pattern.** The F02 schema deliberately omits a DB-level FK from `statuses.campaign_id → campaigns.id` (see comments in `schema.prisma` lines 468-470). The same pattern is used by `pause_codes` (§4.10) and `dnc.campaign_id='__GLOBAL__'` (§4.14). This is operationally cleaner than two separate tables (`system_statuses` + `campaign_statuses`) because (a) the application reads them with one query `WHERE campaign_id IN (?, '__SYS__')`, (b) the unique constraint on `(tenant_id, campaign_id, status)` prevents per-campaign duplicates, and (c) Phase 4 tenant isolation works trivially — each tenant gets its own `__SYS__` row family. Vicidial's split between `vicidial_statuses` (system) and `vicidial_campaign_statuses` (per-campaign) is the legacy alternative — see §2 below for why the unified table is better. **We do NOT replicate Vicidial's split.**

5. **The hangup_cause → status mapper is a pure function with a fallback default.** Per the SPEC.md §D04 module spec line 51 the canonical mapping is: `NORMAL_CLEARING → A` (per agent — the agent already disposed), `USER_BUSY → B-CAR`, `NO_ANSWER → NA-CAR`, `NO_USER_RESPONSE → NA-CAR`, `CALL_REJECTED → B-CAR`, `ORIGINATOR_CANCEL → AGTHU` (agent hangup — we elide AGTHU into `ERI` for Phase 1 since A06 will record the agent's chosen status separately), `MEDIA_TIMEOUT → MEDIA_TO`, `UNALLOCATED_NUMBER → INVALID`, `INVALID_NUMBER_FORMAT → INVALID`, `NETWORK_OUT_OF_ORDER → CARRIER_FAIL`, `NORMAL_TEMPORARY_FAILURE → CARRIER_FAIL`, `USER_NOT_REGISTERED → CARRIER_FAIL`, `GATEWAY_DOWN → CARRIER_FAIL`, `RECOVERY_ON_TIMER_EXPIRE → TIMEOT`, `NORMAL_UNSPECIFIED → NA-CAR` (defensive — we'd rather over-classify as no-answer than under-classify as carrier-fail because no-answer recycles, carrier-fail does not). Unknown causes default to `NA` and emit metric `vici2_d04_hangup_unmapped_total{cause}` so operators can extend the table without code review for each new SIP cause discovered. Full 28-row map in §7. Citations: [10] FreeSWITCH Hangup Cause Code Table; [11] Q.850 cause codes; [12] RFC 3398.

6. **Per-campaign overrides blend three layers, last-write wins per column.** The lookup precedence for any (campaign, status) tuple at read time is: (a) `statuses` row where `(tenant_id, campaign_id=<X>, status)` — full per-campaign shadow row, if any — wins on **all** columns where it's non-NULL; (b) `campaign_status_overrides` row where `(tenant_id, campaign_id=<X>, status_code)` — already in the schema per E01 amendment §10/§12 — wins on the two override-only columns (`recycle_delay_seconds`, `max_calls`); (c) `statuses` row where `(tenant_id, campaign_id='__SYS__', status)` — the system default. The override table is intentionally narrower than a full shadow row because **most overrides are just recycle-delay tweaks** ("on this aggressive resale campaign, retry B in 60s not 300s") and a full shadow row is overkill. Both mechanisms exist; admin UI defaults to using `campaign_status_overrides` for delay-only changes and prompts for a full shadow row only when the operator wants to toggle a flag. Read-time merge logic in §5.

7. **Recycle semantics are a per-status integer of seconds with three special values.** `recycle_delay_seconds = 0` ⇒ immediate recycle (CARRIER_FAIL pattern — pacing race, not lead problem; E01 PLAN §6 already handles this). `recycle_delay_seconds = NULL` ⇒ fall back to `campaigns.default_recycle_delay_seconds` (per E01 amendment §10 col table line 754). `recycle_delay_seconds = -1` ⇒ **terminal** — never recycle even if status is in `dial_statuses` (used for SALE, DNC, INVALID, DEAD, WRONG). Defaults: `NEW=NULL`, `NA=300`, `N=600`, `B=120`, `B-CAR=180`, `NA-CAR=600`, `CALLBK=NULL` (overridden by `callbacks.callback_at` — D06 owns), `CARRIER_FAIL=0`, `GATEWAY_LIMIT_TRY_LATER=0`, `TIMEOT=900`, `MEDIA_TO=300`, `TCPA=NULL` (E01 reads `tcpa.NextOpen()` from C01 instead), `CONSENT_NOT_OBTAINED=-1`, `INVALID=-1`, `SALE=-1`, `DNC=-1`, `XFER=-1`, `DEAD=-1`, `WRONG=-1`, `LM=86400` (24h between voicemails), `DEC=-1`, `NI=-1`, `NP=-1`, `DC=-1`, `ERI=600`, `PDROP=-1`, `DROP=300`. Full table + justification in §3.4.

8. **DNC auto-insert is a side-effect of the SALE → `dnc=true` flag, not a foreign-key cascade.** Agent dispositions a call as `DNC`; A06 calls `dispositionService.submit()`; that handler, **after** writing the `dispositions` row + `leads.status='DNC'` + `call_log.status='DNC'`, reads the status row, sees `dnc=true`, and POSTs to `dncService.addInternal(phone_e164, source='internal', tenant_id, campaign_id)`. The DNC insert is a separate transaction in the same request boundary — failure is logged but does NOT roll back the disposition (operationally we'd rather have the dispo recorded than lose it because DNC writer is down; D05 owns the eventual-consistency reconciliation worker). Same pattern for `is_sale=true` → optional CRM webhook (N01, Phase 4 only). **Sale-flag does NOT auto-insert to DNC** (a separate flag — some shops keep customers callable for upsell). Detailed flow in §9.

9. **The state machine is mostly flat — there are 4 real transitions worth modeling.** Lead lifecycle: `NEW → QUEUE → INCALL → <agent-selected-or-system>`. Callback subgraph: `<any> → CALLBK → CBHOLD → QUEUE → INCALL → <terminal>`. The "CALLBK → CBHOLD" hop is owned by D06 (callback worker promotes when `callback_at < NOW()`); the "QUEUE → INCALL" hop is owned by T01 (CHANNEL_BRIDGE handler). The remaining transitions are illegal: (a) cannot transition out of a `recycle_delay_seconds=-1` status without an admin override (M03 "force recycle" button — audit-logged); (b) cannot transition into `INVALID` from agent action (only from T04 hangup_cause map); (c) cannot transition `SALE → NEW` (Vicidial's "list reset" function — DESIGN.md §17 flagged this as a recurring footgun; we explicitly require a manager-role audit-logged action for it, which lives in M07, not A06). State machine diagram + illegal-transition list in §8.

10. **Open questions for PLAN (top 7 of 13).** (i) Should `dial_statuses` (E01 filter) and `selectable` (D04 flag) be the same concept or two distinct concepts? — recommend **two**: `selectable` = "agent UI shows it in the picker"; `dial_statuses` = "lead with this status is eligible for re-dial by the hopper filler". Example: `CALLBK` is NOT in agent picker (it's a button instead) but IS in `dial_statuses`. (ii) Hotkey conflict detection scope — global, per-campaign, or per-(campaign+system)? — recommend per-campaign because system rows have no hotkeys (system row hotkey is always NULL). (iii) Status code charset — Vicidial allows 1-8 chars `[A-Z0-9_-]`; schema says VARCHAR(8); should we enforce uppercase + character class in service-layer Zod? — recommend yes, with reserved-prefix `__` for system (e.g., `__SYSV2`). (iv) What about `min_call_seconds` / `max_call_seconds` per status (Vicidial has these — see §2.3)? — recommend defer to Phase 3 (not a Phase 1 must-have; over-scoped for MVP). (v) Should `human_answered` be a hard column or a derived predicate `status IN (A, A-MAN, SALE, NI, NP, ...)`? — recommend hard column (denormalized) because the predicate is read on every call in E05's drop-rate calculator (~100 reads/sec/campaign at scale; column lookup is faster than IN list evaluation). (vi) Per-list filtering of selectable statuses? — recommend **defer**: SPEC.md §7 mentions "per-list overrides" but doesn't say what; Phase 2 enhancement if customer asks. (vii) How does D06's `CBHOLD → QUEUE` promotion interact with the per-status `recycle_delay`? — recommend **bypass** (CALLBK has callback_at as the authoritative recycle time; statuses.recycle_delay_seconds for CALLBK should be NULL not a number, to make this obvious). Full 13 in §13.

---

## 2. Vicidial baseline — what the legacy system ships

Vicidial is the unambiguous reference implementation for any open-source predictive dialer status taxonomy. The Vicidial `system_statuses` table ships with ~85 codes (per the `VICIDIAL_statuses.txt` canonical reference [1]) and is the lingua franca of every call-center operator who's been in the industry > 5 years. We replicate the **codes that matter** and the **shape of the columns** but **not the table split**.

### 2.1 Vicidial table layout (the legacy split)

Vicidial splits statuses across two tables:

- `system_statuses` — global, ships out of the box, ~85 rows
- `vicidial_campaign_statuses` — per-campaign overrides, can override flags AND insert per-campaign-only codes (e.g., "QUOTE_SENT" for the Insurance campaign)

The agent UI reads with a UNION ALL:

```sql
SELECT * FROM system_statuses
UNION ALL
SELECT * FROM vicidial_campaign_statuses WHERE campaign_id = ?
```

Per-status agent eligibility is then filtered by the `selectable='Y'` column.

Vicidial-forum reports [4][5] flag this split as the root cause of two recurring bugs: (a) operators add a per-campaign code, agent UI doesn't refresh until a forced reload of `vicidial_campaign_statuses.modify_date`, (b) operators rename a system code to "shadow" it, breaking historical reports because `vicidial_log.status` joins by code, not surrogate key. **Both bugs are eliminated** by our unified `statuses` table with `__SYS__` sentinel — there's no UNION, no codepath difference, no shadow-vs-rename ambiguity.

### 2.2 Vicidial `system_statuses` columns (legacy reference)

Per [2] (the Centrex documentation + the GitHub `MySQL_AST_CREATE_tables.sql`), Vicidial's `system_statuses` schema has these columns:

| Column | Type | Notes |
|---|---|---|
| `status` | VARCHAR(8) PRIMARY KEY | The code |
| `status_name` | VARCHAR(30) | Description |
| `selectable` | ENUM('Y','N') | Shows in agent dropdown |
| `human_answered` | ENUM('Y','N') | Counts toward 3% denominator |
| `category` | VARCHAR(20) | Free-text grouping for reports |
| `sale` | ENUM('Y','N') | Conversion-tracking flag |
| `dnc` | ENUM('Y','N') | Auto-add to internal DNC |
| `customer_contact` | ENUM('Y','N') | Counts toward "contacts" |
| `not_interested` | ENUM('Y','N') | Reporting bucket |
| `unworkable` | ENUM('Y','N') | Reporting bucket (terminal) |
| `scheduled_callback` | ENUM('Y','N') | Triggers callback flow |
| `min_sec` | INT | Agent can pick this only if call duration ≥ min_sec |
| `max_sec` | INT | Agent can pick this only if call duration ≤ max_sec |
| `answering_machine` | ENUM('Y','N') | AMD bucket flag |
| `completed` | ENUM('Y','N') | "Touched" flag for QA |

Our `statuses` model in `schema.prisma` carries the essentials: `selectable`, `human_answered`, `sale`, `dnc`, `callback` (= Vicidial's `scheduled_callback`), `not_interested`, `hotkey`. We **drop** `customer_contact` (derivable: `selectable && !sale && !dnc && human_answered`), `unworkable` (derivable: `recycle_delay_seconds=-1`), `min_sec`/`max_sec` (Phase 3 — Vicidial-forum-cite [4] shows operators rarely use this), `answering_machine` (replaced by category = `system-amd`), `completed` (replaced by `humanAnswered` predicate). We **rename** `scheduled_callback` → `callback` for consistency with TypeScript camelCase elsewhere.

### 2.3 Vicidial's 85-code default ship list (full)

Per [1] (the canonical `VICIDIAL_statuses.txt`), Vicidial ships with these codes, **grouped by purpose**. We map each to a Phase 1 vici2 disposition (and explain why some are dropped):

**Core lifecycle (kept):**
- `NEW` — uncalled lead → vici2 `NEW`
- `QUEUE` — about to be sent to agent → vici2 `QUEUE`
- `INCALL` — talking to lead → vici2 `INCALL`

**Carrier hangup-cause-derived (kept, renamed):**
- `A` — answering machine, agent-defined → vici2 `A`
- `AA` — answering machine, dialer-defined → vici2 `AA`
- `AM`, `AL`, `AMDXFR` — AMD message playback variants → **dropped for Phase 1** (AMD playback is X02-class; not in Phase 1 scope)
- `AFAX` — fax detected → vici2 `AFAX`
- `B` — busy, agent-defined → vici2 `B`
- `AB` — busy, carrier-received → vici2 `B-CAR`
- `DC` — disconnected, agent-defined → vici2 `DC`
- `ADC` — disconnected, carrier-received → vici2 `ADC`
- `ADCT`, `ADCCAR`, `DNCCAR` — TILTX carrier-defined → **dropped** (TILTX is a Vicidial-specific carrier addon)
- `N` — no answer, agent-defined → vici2 `N`
- `NA` — no answer, dialer-defined → vici2 `NA` (system row; agent variant is `N`)
- `DROP` — answered but no agent → vici2 `DROP`
- `XDROP` — inbound drop → **dropped for Phase 1** (inbound is Phase 3; revisit in I01)
- `PDROP` — pre-route drop at answer signal → vici2 `PDROP`

**Agent business outcomes (kept):**
- `SALE` — sale completed → vici2 `SALE`
- `NI` — not interested → vici2 `NI`
- `NP` — no pitch (qualifies out before pitch) → vici2 `NP`
- `DEC` — declined sale → vici2 `DEC`
- `XFER` — transferred to closer/in-group → vici2 `XFER`

**Callback (kept):**
- `CALLBK` — scheduled or non-scheduled callback → vici2 `CALLBK`
- `CBHOLD` — callback hasn't hit trigger time yet → vici2 `CBHOLD`

**DNC (kept):**
- `DNC` — agent flagged → vici2 `DNC`
- `DNCL` — hopper-match of DNC list → **dropped** (E01 filters DNC pre-hopper; never goes to disposition)
- `DNCC` — campaign-specific DNC → **dropped** (E01 filter covers this)

**Survey codes (dropped — Phase 3+):**
- `SVYEXT`, `SVYVM`, `SVYHU`, `SVYREC`, `SVYCLM`, `SVYREJ` — IVR survey transitions → **deferred** until I03/I04 (IVR module)

**CPD / Sangoma codes (dropped):**
- `CPDATB`, `CPDB`, `CPDNA`, `CPDREJ`, `CPDINV`, `CPDSUA`, `CPDSI`, `CPDSNC`, `CPDSR`, `CPDSUK`, `CPDSV`, `CPDUK`, `CPDERR` — Sangoma CPD card-specific codes → **all dropped** (we use FreeSWITCH mod_avmd, not Sangoma hardware; vici2 normalizes to `A` / `AVMA` / `AFAX`)

**Inbound / queue codes (dropped or deferred):**
- `INBND`, `TIMEOT`, `AFTHRS`, `NANQUE`, `IQNANQ`, `HOLDTO`, `WAITTO`, `MAXCAL`, `CLOSOP`, `SRDROP`, `HUCXXX`, `LRERR`, `QVMAIL`, `HXFER`, `RQXFER`, `LTMGAD`, `XAMMAD`, `ALTNUM`, `MLINAT`, `RAXFER`, `IVRXFR`, `UNKXFR`, `UNKAM`, `UNKAL`, `ACFLTR`, `LSMERG`, `DISMX`, `DISPO`, `DONEM`, `ERI`, `PAUSMX`, `PU`, `PM`, `ADAIR`, `NVAINS` — **mostly Phase 3 inbound or edge cases.** We keep `ERI` (agent error / browser closed during dispo — critical for QA), `TIMEOT` (ring timeout), `PDROP`, `DROP`, `DISPO` (folded into `ERI`).

**QC codes (dropped — Phase 4):**
- `QCFAIL`, `QCCANC`, `QCPASS` — quality-control workflow → defer to QA module (S05, not yet specced)

After this culling, **~22 Vicidial codes are kept** (mapped to vici2 names) and **~63 are dropped or deferred**. The 35-status vici2 default seed (§3) adds the 4 new TCPA/CONSENT/CARRIER_FAIL/GATEWAY_LIMIT_TRY_LATER statuses (T04.2 amendment) and a few rename-clarity additions (`WRONG`, `DEAD`, `LM`, `MEDIA_TO`, `INVALID`, `B-CAR`, `NA-CAR`, `AVMA`).

### 2.4 Why we don't replicate Vicidial 1:1

Three reasons:

1. **Operational simplicity.** A 35-status default seed is something an operator can read on one screen and understand. Vicidial's 85-status seed is widely reported [5][6] as confusing — operators add custom codes to "simplify" then can't figure out which is which.
2. **Reporting clarity.** Vicidial's `human_answered` flag is overloaded — it's used for the 3% drop rate denominator AND for "contacts" reporting AND for QA "completed call" counts. Three concepts, one flag → operators mis-configure and FCC reports drift. Our `humanAnswered` is **only** the 3% drop rate denominator (= "live human picked up"); `sale`/`callback`/`not_interested` are separate flags for the other concepts.
3. **Compliance posture.** Vicidial has no `TCPA` or `CONSENT_NOT_OBTAINED` status — those events are buried in `vicidial_log.status='B'` or `='NA'` with a separate `vicidial_compliance_log` table. Our T04 PLAN [9] mandates surfacing TCPA / consent blocks at the lead-status level so the M03 admin UI shows "this lead is blocked because TX state-specific autodial window is closed" without operators having to dig into the compliance log.

### 2.5 GoAutoDial / VicidialNOW forks (no schema delta worth keeping)

GoAutoDial [8] is a Vicidial fork with a polished UI but the same `system_statuses` schema. VicidialNOW [9] is another fork with multi-tenancy support but again the same status taxonomy. **No useful additions to take from the forks.**

---

## 3. The canonical 35-status default seed

This is the authoritative seed list that `db/seeds/system-statuses.json` (or the D04 PLAN-phase equivalent) will populate into `statuses` for `(tenant_id=1, campaign_id='__SYS__')` on a fresh install. Every column has a deliberate value; rationale is in the row notes.

### 3.1 Schema column meanings (recap from `schema.prisma`)

| Column | Type | Semantic |
|---|---|---|
| `status` | VARCHAR(8) | The code; must match `^[A-Z][A-Z0-9_-]{0,7}$` |
| `description` | VARCHAR(128) | Human-readable label for admin UI |
| `selectable` | BOOL | Agent picker shows this in the dropdown |
| `humanAnswered` | BOOL | Counts in the 3% drop-rate **denominator** (live human, real conversation) |
| `sale` | BOOL | Conversion event; rolls up to `sales_per_hour` campaign metric |
| `dnc` | BOOL | Triggers auto-INSERT into `dnc(source='internal')` on disposition |
| `callback` | BOOL | Triggers callback scheduling UI (A08) |
| `notInterested` | BOOL | Reporting bucket; counts vs `contacts` for conversion ratios |
| `hotkey` | CHAR(1) NULL | Single keyboard hotkey for the agent picker (A06) |

Plus the recycle-delay column we are **adding via D04 schema amendment** (see §4):

| Column | Type | Semantic |
|---|---|---|
| `recycleDelaySeconds` | INT NULL | `NULL`=use `campaigns.default_recycle_delay_seconds`; `0`=immediate; `-1`=terminal/never; `>0`=seconds before lead is re-dialable |
| `category` | VARCHAR(20) NULL | Reporting grouping: `agent-outcome` / `system-amd` / `system-carrier` / `system-compliance` / `lifecycle` |
| `systemOwner` | VARCHAR(8) NULL | Which module emits this row: `T04` / `T01` / `E01` / `E05` / `D06` / `__AGT__` (agent) / NULL |

The `systemOwner` column is for documentation and CI lint — a CI check can assert that `T04` originate code only sets statuses where `systemOwner='T04'`, etc. Phase 1 ship; if it proves over-engineered we can drop it.

### 3.2 The full 35-row seed table

Status codes are uppercase, ≤ 8 chars; description ≤ 30 chars target for UI line-fit. Hotkeys 1-9 are reserved for the most-frequent agent-selectable statuses per Vicidial-forum convention [7].

| Status | Description | `selectable` | `humanAnswered` | `sale` | `dnc` | `callback` | `notInterested` | `hotkey` | `recycleDelaySeconds` | `category` | `systemOwner` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `NEW` | Uncalled lead | F | F | F | F | F | F | — | NULL | lifecycle | E01 |
| `QUEUE` | In hopper / about to dial | F | F | F | F | F | F | — | -1 | lifecycle | E01 |
| `INCALL` | Talking to agent right now | F | T | F | F | F | F | — | -1 | lifecycle | T01 |
| `SALE` | Sale completed | T | T | T | F | F | F | 1 | -1 | agent-outcome | __AGT__ |
| `NI` | Not interested | T | T | F | F | F | T | 2 | -1 | agent-outcome | __AGT__ |
| `NP` | No pitch — qualified out | T | T | F | F | F | T | 3 | -1 | agent-outcome | __AGT__ |
| `CALLBK` | Scheduled callback | T | T | F | F | T | F | 4 | NULL | agent-outcome | __AGT__ |
| `DNC` | Do not call | T | T | F | T | F | F | 5 | -1 | agent-outcome | __AGT__ |
| `XFER` | Transferred to closer/in-group | T | T | F | F | F | F | 6 | -1 | agent-outcome | __AGT__ |
| `DEC` | Declined sale | T | T | F | F | F | T | 7 | -1 | agent-outcome | __AGT__ |
| `B` | Busy (agent reached but heard busy) | T | F | F | F | F | F | 8 | 120 | agent-outcome | __AGT__ |
| `N` | No answer (agent let it ring) | T | F | F | F | F | F | 9 | 600 | agent-outcome | __AGT__ |
| `DC` | Disconnected number (agent heard) | T | F | F | F | F | F | — | -1 | agent-outcome | __AGT__ |
| `WRONG` | Wrong number / wrong party | T | T | F | F | F | F | — | -1 | agent-outcome | __AGT__ |
| `DEAD` | Lead deceased / refused contact info | T | T | F | F | F | F | — | -1 | agent-outcome | __AGT__ |
| `LM` | Left voicemail | T | F | F | F | F | F | — | 86400 | agent-outcome | __AGT__ |
| `A` | Answering machine (agent-detected) | T | F | F | F | F | F | — | 14400 | system-amd | __AGT__ |
| `AA` | Answering machine (carrier/AMD-detected) | F | F | F | F | F | F | — | 14400 | system-amd | T04 |
| `AVMA` | AMD beep heard / voicemail tone | F | F | F | F | F | F | — | 14400 | system-amd | T01 |
| `AFAX` | Fax tone detected | F | F | F | F | F | F | — | -1 | system-amd | T04 |
| `B-CAR` | Busy (carrier signal: USER_BUSY) | F | F | F | F | F | F | — | 180 | system-carrier | T04 |
| `NA-CAR` | No answer (carrier signal: NO_ANSWER / NO_USER_RESPONSE) | F | F | F | F | F | F | — | 600 | system-carrier | T04 |
| `ADC` | Carrier reports disconnect / unallocated | F | F | F | F | F | F | — | -1 | system-carrier | T04 |
| `INVALID` | Carrier reports invalid number format | F | F | F | F | F | F | — | -1 | system-carrier | T04 |
| `TIMEOT` | Ring timeout (no SIP response in `dial_timeout_sec`) | F | F | F | F | F | F | — | 900 | system-carrier | T04 |
| `MEDIA_TO` | Media path failed mid-call | F | F | F | F | F | F | — | 300 | system-carrier | T01 |
| `CARRIER_FAIL` | Carrier-side fault (GW down, 5xx, network) — T04.2 seed | F | F | F | F | F | F | — | 0 | system-carrier | T04 |
| `GATEWAY_LIMIT_TRY_LATER` | Concurrent cap hit on gateway — T04.2 seed | F | F | F | F | F | F | — | 0 | system-carrier | T04 |
| `DROP` | Customer answered, no agent in 2s (TCPA abandon) | F | T | F | F | F | F | — | 300 | system-compliance | E05 |
| `PDROP` | Pre-route drop at answer signal | F | T | F | F | F | F | — | -1 | system-compliance | T01 |
| `TCPA` | TCPA call-window blackout — T04.2 seed | F | F | F | F | F | F | — | NULL | system-compliance | T04 |
| `CONSENT_NOT_OBTAINED` | State consent gate failed — T04.2 seed | F | F | F | F | F | F | — | -1 | system-compliance | T04 |
| `ERI` | Agent error (browser closed before dispo) | F | T | F | F | F | F | — | 600 | system-compliance | T01 |
| `CBHOLD` | Callback waiting for trigger time | F | F | F | F | F | F | — | -1 | lifecycle | D06 |
| `EXCEEDED_CALL_CAP` | Lead hit `campaigns.max_calls_per_lead` | F | F | F | F | F | F | — | -1 | system-compliance | E01 |

Total: **35 rows**. Counts by category:
- `lifecycle`: 4 (`NEW`, `QUEUE`, `INCALL`, `CBHOLD`)
- `agent-outcome`: 13 (`SALE`, `NI`, `NP`, `CALLBK`, `DNC`, `XFER`, `DEC`, `B`, `N`, `DC`, `WRONG`, `DEAD`, `LM`)
- `system-amd`: 4 (`A`, `AA`, `AVMA`, `AFAX`)
- `system-carrier`: 8 (`B-CAR`, `NA-CAR`, `ADC`, `INVALID`, `TIMEOT`, `MEDIA_TO`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`)
- `system-compliance`: 6 (`DROP`, `PDROP`, `TCPA`, `CONSENT_NOT_OBTAINED`, `ERI`, `EXCEEDED_CALL_CAP`)

Counts by flag:
- `selectable=true`: 13 (the agent picker shows these)
- `humanAnswered=true`: 11 (3% drop-rate denominator — all selectable that involve a real conversation, plus `DROP`, `PDROP`, `INCALL`, `ERI` because the customer DID answer)
- `sale=true`: 1 (`SALE`)
- `dnc=true`: 1 (`DNC`)
- `callback=true`: 1 (`CALLBK`)
- `notInterested=true`: 3 (`NI`, `NP`, `DEC`)
- `recycleDelaySeconds=-1` (terminal): 19
- `recycleDelaySeconds=0` (immediate): 2 (`CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`)
- `recycleDelaySeconds=NULL` (fall back to campaign default): 3 (`NEW`, `CALLBK`, `TCPA`)

### 3.3 Why these flag assignments

Several rows have surprising flag combinations; here's the rationale.

**`A` (`selectable=true`)**: Vicidial keeps this `selectable=Y` because some shops have agents listen for an AMD greeting and disposition manually rather than trust the AMD detector. We follow suit; per E05 design the campaign-level `machine_terminal` flag controls whether `A` is terminal — flag-on-status only sets the recycle hint.

**`AA` and `AVMA` (`selectable=false`)**: These are system-only — the carrier or T01's mod_avmd writes them. The agent variant is `A`. The `humanAnswered=false` is critical: AMD calls do NOT count in the FCC 3% denominator [3].

**`DROP` (`humanAnswered=true`)**: Because a customer DID pick up — they just got abandoned. This is exactly what the 3% drop rate denominator is supposed to count. `is_drop=true` is set on the corresponding `call_log` row by E05.

**`ERI` (`humanAnswered=true`)**: Browser-closed dispo means the call happened, agent talked, then UI crashed. We count it in human_answered because a conversation occurred; we count it in `not_interested=false` because we have no idea what the outcome was. Operationally this is a "QA review" bucket — supervisor S01 surfaces these for manual disposition correction.

**`B` (`selectable=true`, `recycleDelaySeconds=120`)**: Vicidial-forum-cite [4] reports widespread operator complaint that `B` recycles too slowly (Vicidial default 300s). 120s is the modal industry value [13].

**`CARRIER_FAIL` (`recycleDelaySeconds=0`)**: Per T04 PLAN §3.7 carrier failures are **pacing-side problems, not lead-side**. We immediately re-queue the lead so a sibling FS / sibling gateway gets a shot.

**`TCPA` (`recycleDelaySeconds=NULL`)**: E01's TCPA gate computes the actual next-open time from C01's `tcpa.NextOpen(lead)` and re-queues to the delayed-set at that moment. The status row's `recycle_delay_seconds` is irrelevant for TCPA — written as NULL to make it obvious.

**`LM` (`recycleDelaySeconds=86400`)**: Leaving the same person two voicemails within 24h is a per-FTC-TSR-guidance compliance hazard [3]. 24h floor enforced via the status row.

**`SALE`, `DNC`, `INVALID`, `WRONG`, `DEAD`, `DEC`, `NI`, `NP` etc. (`recycleDelaySeconds=-1`)**: All terminal — never recall. Operationally: the lead is "done" and won't be re-dialed until manual admin intervention (M03 "force recycle" — audit-logged).

### 3.4 Recycle-delay derivation table

The defaults above come from synthesizing three sources: (a) Vicidial defaults (forum-cite [4][5]), (b) FTC TSR guidance for legitimate retry frequency [3], (c) industry common-sense (don't retry busy in <1min; don't retry no-answer in <5min):

| Status | Vicidial default | FTC guidance | Industry typical | vici2 ship |
|---|---|---|---|---|
| `B` | 300s | not specified | 120s | **120s** |
| `B-CAR` | 600s | not specified | 180s | **180s** |
| `N` | 1800s | not specified | 600s | **600s** |
| `NA-CAR` | 1800s | not specified | 600s | **600s** |
| `A` / `AA` | 14400s (4h) | "don't ping voicemail repeatedly" | 14400s | **14400s** |
| `LM` | 86400s | "don't leave 2 vm/24h" | 86400s | **86400s** |
| `TIMEOT` | 900s | not specified | 600s | **900s** |
| `MEDIA_TO` | n/a | n/a | 300s | **300s** |
| `DROP` | n/a | "drop should retry per safe-harbor message" | 300s | **300s** |
| `ERI` | 900s | n/a | 600s | **600s** |

Per-campaign override available via `campaign_status_overrides.recycle_delay_seconds` (already in schema).

---

## 4. Schema — what D04 adds to F02

The F02 schema landed the `Status` model and the `CampaignStatusOverride` model. D04's PLAN phase needs to add **three columns to `statuses`**:

```prisma
model Status {
  // ... existing columns ...
  recycleDelaySeconds Int?    @map("recycle_delay_seconds")  // NULL / 0 / -1 / >0
  category            String? @db.VarChar(20)                // 'agent-outcome' | 'system-*' | 'lifecycle'
  systemOwner         String? @map("system_owner") @db.VarChar(8)  // 'T04' | 'T01' | 'E01' | 'E05' | 'D06' | '__AGT__'
  // existing @@id and @@map unchanged
}
```

Migration: `api/prisma/migrations/<date>_d04_status_recycle/migration.sql` adds the three nullable columns + a CHECK constraint (MySQL 8.0.16+) that `recycle_delay_seconds IN (-1, 0) OR recycle_delay_seconds > 0` (no negatives other than -1).

CI lint (extend `scripts/ci/check-tenant-index-leadership.sh`-style script):

- A new `scripts/ci/check-status-seed.sh` that asserts the `db/seeds/system-statuses.json` has exactly 35 rows, every row has `systemOwner` set, and every row's `(category, systemOwner)` is consistent (e.g., `system-compliance` rows have `systemOwner IN ('T04', 'T01', 'E05', 'E01')`).

The `campaign_status_overrides` table already exists with `recycle_delay_seconds` and `max_calls` columns and the FK to campaigns is correct. No D04 changes needed there.

---

## 5. Per-campaign overrides — three-layer blend

### 5.1 Lookup precedence (read path)

For any `(tenant_id, campaign_id, status)` triple, the effective row is computed as:

```
effective[col] = COALESCE(
    statusesWhere(tenant_id, campaign_id, status)[col],   -- full per-campaign shadow row
    campaign_status_overrides(tenant_id, campaign_id, status)[col],  -- delay-only override
    statusesWhere(tenant_id, '__SYS__', status)[col]      -- system default
)
```

`campaign_status_overrides` only supplies columns `recycle_delay_seconds` and `max_calls` (no other columns); the merge for those two columns goes through it. All other columns (selectable, hotkey, description, sale, dnc, callback, etc.) skip the override table and use just (shadow row → system row).

### 5.2 Materialized query (single SQL hit)

```sql
SELECT
    s.status,
    COALESCE(c.description,    sys.description)    AS description,
    COALESCE(c.selectable,     sys.selectable)     AS selectable,
    COALESCE(c.human_answered, sys.human_answered) AS human_answered,
    COALESCE(c.sale,           sys.sale)           AS sale,
    COALESCE(c.dnc,            sys.dnc)            AS dnc,
    COALESCE(c.callback,       sys.callback)       AS callback,
    COALESCE(c.not_interested, sys.not_interested) AS not_interested,
    COALESCE(c.hotkey,         sys.hotkey)         AS hotkey,
    COALESCE(c.recycle_delay_seconds, o.recycle_delay_seconds, sys.recycle_delay_seconds)
                                                  AS recycle_delay_seconds,
    COALESCE(o.max_calls,      sys.max_calls)      AS max_calls,
    COALESCE(c.category,       sys.category)       AS category,
    COALESCE(c.system_owner,   sys.system_owner)   AS system_owner
FROM (
    SELECT DISTINCT status
      FROM statuses
     WHERE tenant_id = ?
       AND campaign_id IN (?, '__SYS__')
) s
LEFT JOIN statuses c
       ON c.tenant_id = ? AND c.campaign_id = ?           AND c.status = s.status
LEFT JOIN statuses sys
       ON sys.tenant_id = ? AND sys.campaign_id = '__SYS__' AND sys.status = s.status
LEFT JOIN campaign_status_overrides o
       ON o.tenant_id = ? AND o.campaign_id = ?           AND o.status_code = s.status
ORDER BY (system_owner = '__AGT__') DESC, hotkey, status;
```

Hot query — gets cached for 60s in the `StatusService` (in-process LRU keyed by `(tenant_id, campaign_id)`; busted on PATCH/DELETE).

### 5.3 Cache invalidation

Any write to `statuses` or `campaign_status_overrides` publishes `pubsub:t:{tid}:status_changed:{cid}` on Valkey. All API workers consume and invalidate their local LRU entries. SLA: <250ms global cache invalidation; for hotter paths E01/E05 already re-read on every tick so they don't need the cache.

### 5.4 UPSERT semantics

`PATCH /api/admin/campaigns/:cid/statuses/:code` semantics:

- If `:cid` is the special `__SYS__` and code is a system-owner row → `403 system_status_immutable`. (System rows are admin-of-tenant editable only through `M07` super-admin path with audit log.)
- Else if only `recycle_delay_seconds` or `max_calls` is being changed → INSERT/UPDATE `campaign_status_overrides`. (Faster, more granular, single audit-log entry.)
- Else (any non-override column being changed) → INSERT/UPDATE `statuses` shadow row (campaign_id=`:cid`).
- POST creates a new per-campaign status (campaign-only, not shadowing a system row); the code must not already exist for `(tenant_id, '__SYS__')`.

---

## 6. `selectable` vs `dial_statuses` — two distinct concepts

Open question (i) resolved: these ARE two different things.

| Concept | Location | Semantic |
|---|---|---|
| `statuses.selectable` | per-status flag | "Agent UI A06 shows this in the disposition picker" |
| `campaigns.dial_statuses` | JSON array per campaign | "When the hopper-filler scans for leads to re-dial, leads with these statuses qualify" |

Example divergences:

- `CALLBK` — `selectable=true` (agent picks it when scheduling a callback) AND in `dial_statuses` (the callback eventually fires and the lead is re-dialed). But `selectable` doesn't put CALLBK on the agent's regular dropdown — A06 routes through a callback modal (A08).
- `INVALID` — `selectable=false` (system-only) AND **not** in default `dial_statuses` (terminal).
- `NEW` — `selectable=false` (no agent picks "uncalled" as a dispo) AND **always** in `dial_statuses` (else nothing would be dialed).
- `DNC` — `selectable=true` (agent picks it) but **never** in `dial_statuses` (no re-dial after DNC).

The E01 filler JOIN uses `dial_statuses` (campaign-level array) for the lead filter; the A06 picker uses `selectable` (status-level flag) for the dropdown filter. They do not overlap.

Validation rule for D04 PATCH: `selectable=false` on a status that's currently in some campaign's `dial_statuses` is **allowed** (the lead can still be in the hopper from a previous filler run); but **PATCH that sets `selectable=false` on an agent-outcome category status** emits a warning to the API caller because it removes the status from the agent picker.

---

## 7. FreeSWITCH hangup_cause → status mapping (full 28-row table)

This is the canonical mapping used by `D04.resolveFromHangup(campaignId, hangupCause)`. It is invoked by **T04** in the BACKGROUND_JOB-resolved code path when an originate attempt ends without reaching CHANNEL_BRIDGE, and by **T01** for any post-bridge customer-side hangup that didn't get an explicit agent disposition. Per T04 PLAN §3 it is also used by the `OriginateError.D04Status()` typed-error hint translator for the 4 compliance failure modes.

| FS `hangup_cause` | Q.850 | Maps to status | Rationale |
|---|---|---|---|
| `NORMAL_CLEARING` | 16 | (use existing agent-set status, default `A` if pre-bridge) | Normal termination; agent already set the dispo |
| `USER_BUSY` | 17 | `B-CAR` | Carrier reports busy |
| `NO_ANSWER` | 19 | `NA-CAR` | Carrier reports ring-no-answer |
| `NO_USER_RESPONSE` | 18 | `NA-CAR` | Carrier reports no SIP 200 OK |
| `CALL_REJECTED` | 21 | `B-CAR` | Equipment rejecting (close to busy) |
| `ORIGINATOR_CANCEL` | 487 | `ERI` | Agent or pacing cancelled mid-ring; route to QA review |
| `MEDIA_TIMEOUT` | 604 | `MEDIA_TO` | Mid-call media loss |
| `UNALLOCATED_NUMBER` | 1 | `INVALID` | Number not assigned by carrier |
| `INVALID_NUMBER_FORMAT` | 28 | `INVALID` | Number malformed |
| `NORMAL_TEMPORARY_FAILURE` | 41 | `CARRIER_FAIL` | Short-duration network fault |
| `RECOVERY_ON_TIMER_EXPIRE` | 102 | `TIMEOT` | T1/T2/T3 timer expired |
| `NORMAL_UNSPECIFIED` | 31 | `NA-CAR` | Defensive default (NA over CARRIER_FAIL — see §1.5) |
| `NETWORK_OUT_OF_ORDER` | 38 | `CARRIER_FAIL` | Persistent network malfunction |
| `USER_NOT_REGISTERED` | 606 | `CARRIER_FAIL` | SIP user not registered (carrier-side) |
| `GATEWAY_DOWN` | 609 | `CARRIER_FAIL` | Gateway not responding to OPTIONS |
| `EXCHANGE_ROUTING_ERROR` | 25 | `CARRIER_FAIL` | Carrier routing problem |
| `DESTINATION_OUT_OF_ORDER` | 27 | `CARRIER_FAIL` | Destination unreachable |
| `RESPONSE_TO_STATUS_ENQUIRY` | 30 | `CARRIER_FAIL` | Carrier-side SIP status enquiry |
| `NETWORK_CONGESTION` | 42 | `CARRIER_FAIL` | Network busy — retry immediately |
| `ACCESS_INFO_DISCARDED` | 43 | `CARRIER_FAIL` | Carrier protocol error |
| `REQUESTED_CHAN_UNAVAIL` | 44 | `CARRIER_FAIL` | No carrier channel — retry immediately |
| `INCOMING_CALL_BARRED` | 54 | `INVALID` | Carrier refusing to terminate (likely DNC at carrier) |
| `BEARERCAPABILITY_NOTAUTH` | 57 | `CARRIER_FAIL` | Carrier capability mismatch |
| `BEARERCAPABILITY_NOTAVAIL` | 58 | `CARRIER_FAIL` | Carrier codec mismatch |
| `SERVICE_UNAVAILABLE` | 63 | `CARRIER_FAIL` | Carrier 5xx |
| `INTERWORKING` | 127 | `CARRIER_FAIL` | Carrier-to-carrier protocol error |
| `MANAGER_REQUEST` | 502 | `ERI` | Operator-initiated kill (e.g., S03 force-pause path) |
| `(unknown)` | * | `NA` | Default fallback; emit `vici2_d04_hangup_unmapped_total{cause}` |

Mapping data is stored as JSON (`db/seeds/hangup-cause-map.json`) loaded into a service-local `Map<string, string>` on boot. Hot-reloadable via `POST /api/admin/d04/reload`.

---

## 8. State machine & illegal transitions

### 8.1 Happy path

```
NEW ──(E01 filler claims)──→ QUEUE ──(T01 CHANNEL_CREATE)──→ <originating>
                                                                  │
                                          ┌───────────────────────┼─────────────────────────┐
                                          │                       │                         │
                                  (CHANNEL_BRIDGE)        (CHANNEL_HANGUP pre-bridge)   (T04 gate blocks)
                                          │                       │                         │
                                          ▼                       ▼                         ▼
                                       INCALL                T04.resolveFromHangup   {TCPA|DNC|CONSENT_NOT_OBTAINED|
                                          │                       │                  CARRIER_FAIL|GATEWAY_LIMIT_TRY_LATER}
                       (agent submits A06 dispo)                  │
                                          │           {B-CAR|NA-CAR|ADC|INVALID|TIMEOT|CARRIER_FAIL|MEDIA_TO|A|AA|AVMA|AFAX|DROP|PDROP}
                                          ▼
                                 {SALE|NI|NP|DEC|B|N|DC|WRONG|DEAD|XFER|LM|DNC|CALLBK|A}
                                          │
                                  ┌───────┴─────────┐
                                  │                 │
                          (recycle_delay>0)    (recycle_delay=-1)
                                  │                 │
                                  ▼                 ▼
                         (E01 puts back NEW-eligible)   TERMINAL
```

CALLBK subgraph:

```
<any-agent-dispos-as-CALLBK> ──(A08 schedules)──→ CALLBK
                                                    │
                                            (D06 callback worker
                                             promotes when callback_at <= NOW())
                                                    │
                                                    ▼
                                                  CBHOLD ──(D06 triggers)──→ QUEUE → INCALL → ...
```

### 8.2 Illegal transitions

| From | To | Why illegal | Enforcement |
|---|---|---|---|
| any agent-outcome | `NEW` | Lead can't "un-call" itself; M07 "list reset" is the audit-logged route | `dispositionService.submit()` rejects `code=='NEW'` |
| any | `INCALL` | Only T01 CHANNEL_BRIDGE handler may set this; never an admin or agent | API surface excludes `INCALL` from PATCH |
| any | `QUEUE` | Only E01 hopper-filler may set this | API surface excludes `QUEUE` from PATCH |
| `SALE` | anything other than `SALE` | Sales are sacred; only super-admin can change | M07 audit-log path required; A06 disposition modal hides SALE recall |
| `recycle_delay=-1` status | anything | Terminal; only manager force-recycle | M03 button → `POST /api/leads/:id/recycle` (D06 owns) |
| `DNC` | not-`DNC` | DNC is sticky by FTC TSR [3] — removing requires C04 audit trail | M06 admin (DNC admin) — not D04 — has the only path |
| any | `INVALID` | Only T04 hangup map may set | API surface excludes `INVALID` from PATCH |

### 8.3 Race-condition guards

- E01 increments `called_count` and sets `last_called_at` in the SAME UPDATE as the disposition (per E01 PLAN §10.x) to prevent the "two dialers race to dispose" case.
- D04 writes are last-write-wins by design (per D01 PLAN §1.4 — dispositions bypass optimistic locking); the audit log captures the order so QA can reconstruct.
- The `lead.status_changed` event (D01 PLAN §14.4 owned by D04) is emitted AFTER the UPDATE returns affected_rows≥1; if 0, no event fires.

---

## 9. DNC / sale / callback side-effects

### 9.1 Disposition handler — pseudo-code

```typescript
async function submitDisposition(req: DispositionInput): Promise<Disposition> {
  const status = await statusService.resolve(req.campaignId, req.statusCode);
  if (!status) throw new ApiError(404, 'status_not_found');
  if (!status.selectable) throw new ApiError(403, 'status_not_agent_selectable');

  await prisma.$transaction(async (tx) => {
    // 1. Write disposition row (D04 owns)
    const dispo = await tx.disposition.create({ data: { ...req, disposedAt: new Date() } });
    // 2. Update lead status (last-write-wins)
    await tx.lead.update({
      where: { id: req.leadId, tenantId: req.tenantId },
      data: { status: req.statusCode, modifyAt: new Date(), calledCount: { increment: 1 } },
    });
    // 3. Update call_log row
    await tx.callLog.update({
      where: { uuid: req.callUuid, tenantId: req.tenantId },
      data: { status: req.statusCode },
    });
  });

  // After tx commits — non-blocking side effects:
  if (status.dnc) {
    // D05 owns; we fire-and-forget
    dncService.addInternal({
      tenantId: req.tenantId,
      phoneE164: req.phoneE164,
      source: 'internal',
      campaignId: status.dncScope === 'CAMPAIGN' ? req.campaignId : '__GLOBAL__',
      addedBy: req.userId,
    }).catch(err => logger.error('dnc_add_failed', { err, ...req }));
  }
  if (status.callback) {
    // A08 already scheduled the callback row; D06 owns the worker
    // (We do not auto-create the callback here — UI does that explicitly.)
  }
  if (status.sale) {
    // N01 CRM webhook (Phase 4) — fire-and-forget
    if (campaign.crmWebhookUrl) { ... }
  }

  // Emit lead.status_changed event (D01 PLAN §14.4)
  await events.publish('lead.status_changed', {
    tenantId: req.tenantId, leadId: req.leadId, oldStatus: '...', newStatus: req.statusCode,
    timestamp: new Date(), userId: req.userId,
  });

  return dispo;
}
```

### 9.2 Failure modes

| Failure | Behavior |
|---|---|
| DNC service down | Dispo committed; DNC insert retried by D05 worker reading `dispositions` table where `status.dnc=true` and `phone not in dnc` (eventually-consistent) |
| CRM webhook down | Dispo committed; N01 has a dead-letter queue |
| Event bus down | Dispo committed; consumers re-read from `dispositions` table on cold-start sweep |
| Lead status `UPDATE` returns 0 rows | Lead deleted between agent-load and dispo-submit; `404 lead_gone`; UI returns to ready state |

---

## 10. Reporting / aggregation roll-up

The flags on `statuses` drive every campaign-level metric. The roll-up map:

| Metric | Formula | Reads which status flag |
|---|---|---|
| **Connect rate** | `count(humanAnswered=true) / count(*)` over a campaign × time window | `humanAnswered` |
| **Sales rate** | `count(sale=true) / count(humanAnswered=true)` | `sale`, `humanAnswered` |
| **Drop rate (TCPA)** | `count(status IN ('DROP','PDROP')) / count(humanAnswered=true)` rolling 30 days | hard-coded status set + `humanAnswered` |
| **Conversion rate** | `count(sale=true) / count(*)` | `sale` |
| **Callback rate** | `count(callback=true) / count(*)` | `callback` |
| **Refusal rate** | `count(notInterested=true) / count(humanAnswered=true)` | `notInterested`, `humanAnswered` |
| **Carrier failure rate** | `count(category='system-carrier' AND humanAnswered=false) / count(*)` | `category`, `humanAnswered` |
| **AMD rate** | `count(category='system-amd') / count(*)` | `category` |

Owned by M08 (Reports module); M08 reads these flags from D04 via `GET /api/admin/statuses?category=*`.

**Critical invariant**: the FCC 3% drop rate denominator is exactly `count(humanAnswered=true)` — NOT "all calls" and NOT "all answered including AMD". This is the source of countless TCPA reporting bugs in Vicidial-land [3][5]; we encode it in a single column and a single denominator query for clarity.

---

## 11. TCPA / compliance interaction

### 11.1 DNC

- Agent dispositions as `DNC` → auto-insert into `dnc(source='internal')` per §9.1
- Future hopper scans by E01 hit the `dnc` table via Bloom filter (D05) and skip the phone
- `dnc` row also covers `phoneAlt` / `phoneAlt2` if the campaign has `dnc_includes_alts=true` (E01 amendment configurable)

### 11.2 DROP / PDROP — the 3% abandon rate

- E05 monitors live calls: if customer answers and no agent is bridged within 2s, T01 plays the safe-harbor message and hangs up; E05 sets the status to `DROP` and `call_log.is_drop=true`
- 30-day rolling drop% calculation: `SELECT SUM(is_drop) / SUM(s.human_answered) FROM call_log c JOIN statuses s ON c.status=s.status WHERE c.tenant_id=? AND c.campaign_id=? AND c.call_started >= NOW() - INTERVAL 30 DAY`
- E05 then publishes the gauge to Valkey `t:{tid}:campaign:{cid}:drop_pct` — read by O01 (Grafana) and E02 (drop_gate clamp)

### 11.3 TCPA blackout status

- When E01's TCPA gate (via C01) returns SKIP_UNTIL, the lead's status is **NOT** changed to `TCPA` (the lead is still NEW or NA); only the lead enters Valkey's delayed-set
- When T04's TCPA gate blocks an originate (rare — should have been filtered by E01), the originate attempt is recorded with `originate_audit.outcome='TCPA_BLOCKED'` AND the lead status is set to `TCPA` (per T04 PLAN §3 — `D04Status()` typed-error hint)
- Per T04 PLAN — the lead status `TCPA` means "this lead was blocked at originate time"; E01's filler then sees status=`TCPA`, joins to `statuses` for `recycle_delay_seconds=NULL`, and falls back to C01's `tcpa.NextOpen(lead)` to compute the delayed-set score

### 11.4 CONSENT_NOT_OBTAINED

- T04's consent gate (5th gate, ~200ns hot-path) sets `originate_audit.outcome='CONSENT_BLOCKED'` and lead status `CONSENT_NOT_OBTAINED`
- recycle_delay_seconds=-1 (terminal); admin must explicitly re-consent the lead before it dials
- Surfaces in M03 admin UI with a banner "lead blocked due to state consent law (state={state})"

### 11.5 Recording-related compliance

- C02 (recording consent handler) owns recording start/stop logic
- D04 does NOT have a status for "recording-related-block" — instead C02 returns `decision=SKIP_RECORDING` and the call proceeds without recording (and an `originate_audit.consent_decision=SKIP_RECORDING` row is written)

---

## 12. Seed data — Phase 1 minimal vs full set

### 12.1 Phase 1 ship — all 35 statuses seeded

We seed all 35 on install. The argument for seeding even the system-amd / system-carrier rows (which look "useless" until Phase 2 auto-dial) is:

- Manual-dial (Phase 1) also produces hangup events (`USER_BUSY`, `NO_ANSWER`) → the mapper needs these status rows to exist
- Operators in Phase 1 explore the system and expect to see the "real" disposition list, not a cut-down one
- 35 rows is < 10ms total to seed; no performance concern

### 12.2 Phase 1 minimal — what could be dropped if pressed

If we had to ship only the absolute minimum, the cut-down list would be:

- Lifecycle (4): NEW, QUEUE, INCALL, CBHOLD
- Agent-selectable (10): SALE, NI, DNC, CALLBK, XFER, B, N, DC, A, LM
- System-from-hangup (5): B-CAR, NA-CAR, ADC, INVALID, TIMEOT
- System-compliance (2): DROP, ERI

= 21 rows. But we ship 35 to avoid Phase 2 migration churn.

### 12.3 Seed lifecycle

- `db/seeds/system-statuses.json` — declarative, versioned, idempotent
- `npm run seed` (in `api/`) is idempotent: UPSERTs each row
- D04 PLAN includes a CI test that asserts running the seed twice yields identical state
- New tenant creation (Phase 4): a tenant-create worker copies the system statuses into the new tenant's `(tenant_id=N, campaign_id='__SYS__')` rows

---

## 13. API surface

### 13.1 REST endpoints

| Method | Path | Owned by | Notes |
|---|---|---|---|
| `GET` | `/api/admin/system-statuses` | D04 | List the 35 `__SYS__` rows; cached 5min |
| `GET` | `/api/admin/campaigns/:cid/statuses` | D04 | List effective statuses for campaign (3-layer merge); used by A06 picker init |
| `POST` | `/api/admin/campaigns/:cid/statuses` | D04 | Create per-campaign custom status; rejects if code exists in `__SYS__` |
| `PATCH` | `/api/admin/campaigns/:cid/statuses/:code` | D04 | Update per-campaign; rejects system-immutable columns |
| `DELETE` | `/api/admin/campaigns/:cid/statuses/:code` | D04 | Soft-delete the per-campaign shadow row only; never deletes `__SYS__` row |
| `GET` | `/api/admin/hangup-cause-map` | D04 | Returns the JSON map for admin UI display |
| `POST` | `/api/admin/d04/reload` | D04 | Force-reload seed + hangup map (operator emergency) |
| `GET` | `/api/admin/campaigns/:cid/dial-statuses` | E01-owned (not D04) | The JSON-array filter; lives on campaigns table |

### 13.2 Service interface

```typescript
class StatusService {
  list(tenantId: bigint, campaignId: string): Promise<EffectiveStatus[]>
  resolve(tenantId: bigint, campaignId: string, code: string): Promise<EffectiveStatus | null>
  upsert(tenantId: bigint, campaignId: string, def: StatusDef): Promise<EffectiveStatus>
  delete(tenantId: bigint, campaignId: string, code: string): Promise<void>
  resolveFromHangup(tenantId: bigint, campaignId: string, hangupCause: string): Promise<string>
  isSelectable(tenantId: bigint, campaignId: string, code: string): Promise<boolean>
  isDnc(tenantId: bigint, campaignId: string, code: string): Promise<boolean>
  isCallback(tenantId: bigint, campaignId: string, code: string): Promise<boolean>
  hotkeyMap(tenantId: bigint, campaignId: string): Promise<Record<string, string>>
  validateTransition(tenantId: bigint, campaignId: string, fromCode: string, toCode: string): Promise<TransitionResult>
}

type EffectiveStatus = {
  code: string;
  description: string;
  selectable: boolean;
  humanAnswered: boolean;
  sale: boolean;
  dnc: boolean;
  callback: boolean;
  notInterested: boolean;
  hotkey: string | null;
  recycleDelaySeconds: number | null;  // -1 = terminal, 0 = immediate, NULL = campaign default
  maxCalls: number | null;             // from campaign_status_overrides
  category: string | null;
  systemOwner: string | null;
  source: 'shadow' | 'override' | 'system';  // which layer this row came from
};
```

### 13.3 RBAC

| Action | Required permission |
|---|---|
| GET /statuses (list) | `campaigns:read` (RBAC perm) |
| POST/PATCH/DELETE | `campaigns:edit` |
| POST /d04/reload | `admin:system` (super-admin only) |
| GET /hangup-cause-map | `admin:read` |

### 13.4 Validators (Zod, shared via @vici2/contracts)

- `status` code: regex `^[A-Z][A-Z0-9_-]{0,7}$`, length 1-8
- `hotkey`: `null` or single char `[0-9]`
- `recycle_delay_seconds`: `null` or `-1` or integer ≥ 0
- `category`: `null` or one of `agent-outcome` / `system-amd` / `system-carrier` / `system-compliance` / `lifecycle`
- Hotkey uniqueness: PATCH that would assign hotkey '1' to two statuses in the same campaign → `409 hotkey_conflict`

---

## 14. Open questions for PLAN (full 13)

| # | Question | Recommendation |
|---|---|---|
| 1 | `selectable` vs `dial_statuses` — same concept? | **Two distinct concepts** (§6). |
| 2 | Hotkey conflict detection scope | **Per-campaign** (`(tenant_id, campaign_id)` unique on `hotkey` where not null). |
| 3 | Status code charset | Regex `^[A-Z][A-Z0-9_-]{0,7}$`; reserved `__` prefix for system. |
| 4 | min_call_seconds / max_call_seconds per status | **Defer to Phase 3.** Not Phase 1 must-have. |
| 5 | `humanAnswered` hard column vs derived predicate | **Hard column** (read-perf at scale; E05 reads it on every drop% calc). |
| 6 | Per-list filtering of selectable statuses | **Defer to Phase 2** if customer asks. Not in SPEC.md. |
| 7 | CBHOLD → QUEUE promotion and recycle_delay | `CALLBK` and `CBHOLD` have `recycle_delay_seconds=NULL` (D06's `callback_at` is the authoritative recycle time). |
| 8 | Per-campaign sale/dnc flag overrides allowed? | **Yes** (full shadow row). E.g., a debt-collection campaign marks `B` as `dnc=true` (state law). |
| 9 | DNC scope: tenant-wide or campaign-only? | **Per-status field** `dncScope ENUM('GLOBAL','CAMPAIGN')` defaulting to GLOBAL. Defer the column-add; ship GLOBAL-only Phase 1. |
| 10 | Effective-status cache invalidation latency | **<250ms** via pubsub; not tighter (E01/E05 re-read on every tick anyway). |
| 11 | Should D04 own `lead.status_changed` event emission? | **Yes** (D01 PLAN §14.4 explicitly assigns it). |
| 12 | M07 "list reset" — does it call D04 or directly UPDATE `leads`? | **Via D04** — `POST /api/admin/leads/bulk-reset` (D04 service) writes a `dispositions` row of synthetic type `RESET` (M07 owns the UI, D04 owns the service). |
| 13 | Should `systemOwner` column ship Phase 1? | **Yes** — useful for CI lint; cheap; future-proofs the audit trail. |

---

## 15. Risks (PLAN-phase top 5)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Unmapped hangup_cause** drift over time as carriers add new causes | High | Low (defaults to `NA`) | Metric `vici2_d04_hangup_unmapped_total{cause}` triggers operator alert; admin UI shows top N unmapped causes; map is JSON-reloadable without code deploy |
| **Three-layer merge complexity** causes incorrect picker render | Medium | High (agent-side UX bug) | SQL is in §5.2 with explicit COALESCE; unit-tested with fixture matrix (one row per merge precedence case); A06 integration test asserts effective picker matches expected for canonical campaigns |
| **`humanAnswered` flag misuse** in M08 reports → wrong FCC drop% reporting | Medium | High (compliance / litigation) | Single canonical denominator query `SELECT SUM(s.human_answered) FROM call_log c JOIN statuses s ON c.status=s.status`; M08 PLAN forbids any other denominator; CI grep prevents drift |
| **System status accidentally deleted** | Low | High (originate path breaks) | `DELETE /statuses/:code` rejects rows where `campaign_id='__SYS__'`; service-layer also rejects `selectable=true → false` writes that drop a code currently in `dial_statuses` (warning + audit log entry) |
| **Per-status `recycle_delay_seconds=-1` foot-gun** — operator sets terminal on `B` and never re-dials busy leads | Medium | Medium (campaign throughput drop) | M07 admin UI surfaces a warning "this status currently has X leads attached; making it terminal will prevent re-dial"; admin must confirm; metric `vici2_d04_terminal_recycle_writes_total` |

---

## 16. PLAN-phase deliverables

- D04 PLAN should produce:
  - `spec/modules/D04/PLAN.md` (this RESEARCH's recommendations baked into contracts)
  - `db/seeds/system-statuses.json` (the 35-row seed)
  - `db/seeds/hangup-cause-map.json` (the 28-row mapper)
  - Schema amendment for the three new `statuses` columns (`recycle_delay_seconds`, `category`, `system_owner`)
  - Migration file `api/prisma/migrations/<date>_d04_status_extension/`
  - CI lint script `scripts/ci/check-status-seed.sh`
  - HANDOFF.md for downstream consumers (A06, E01, T04, M07, M08, E05)

---

## 17. Citations

[1] **VICIDIAL_statuses.txt — canonical reference list.**
    https://vicidial.org/docs/VICIDIAL_statuses.txt
    Comprehensive list of every VICIdial system status code with description and category annotations.

[2] **Vicidial GitHub — MySQL_AST_CREATE_tables.sql** (system_statuses + vicidial_campaign_statuses schemas).
    https://github.com/inktel/Vicidial/blob/master/extras/MySQL_AST_CREATE_tables.sql

[3] **FCC TCPA / FTC TSR — 3% abandon rate safe-harbor + DNC requirements.**
    - SIPNEX: "Abandoned Call Rate: FCC 3% Rule Explained" — https://www.sipnex.ca/blog/abandoned-call-rate-fcc-rules
    - CompliancePoint: "Beginner's Guide to the TCPA" — https://www.compliancepoint.com/articles/beginners-guide-to-the-tcpa/
    - DNC.com: "Understanding Abandoned Call Rules Under the TCPA" — https://www.dnc.com/blog/tcpa-tools-necessary-for-compliance-0-0
    - 47 C.F.R. § 64.1200(a)(7) — 3% abandon, 30-day window, per-campaign measurement
    - 16 C.F.R. § 310.4(b)(4) — TSR equivalent

[4] **Vicidial forum — disposition definitions & system status questions.**
    https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=40790
    https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=18581
    Operator threads with real-world disposition pain points and recommended recycle delays.

[5] **Vicidial forum — DNC status interactions and List reset behaviors.**
    http://www.vicidial.org/VICIDIALforum/viewtopic.php?p=130408
    http://vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=38236

[6] **Vicidial forum — Hot Keys configuration.**
    https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=7&t=9448
    Recommended hotkey assignment conventions (1=SALE, 2=NI, etc.)

[7] **ViciStack glossary — Disposition definition.**
    https://vicistack.com/glossary/disposition/

[8] **GoAutoDial — open-source Vicidial fork status reference.**
    https://goautodial.org/boards/3/topics/17521

[9] **Five9 system dispositions documentation.**
    https://documentation.five9.com/bundle/basic-admin/page/basic-admin/dispositions/system-dispositions.htm
    https://documentation.five9.com/bundle/admin-console/page/admin-console/dispositions/types-of-dispositions.htm
    Modern SaaS dispositioning model — three-bucket categorization (Final, Non-Final, Redial) referenced in §10.

[10] **FreeSWITCH Hangup Cause Code Table (SignalWire).**
     https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Troubleshooting-Debugging/Hangup-Cause-Code-Table_3964945/
     Canonical mapping of hangup_cause strings to Q.850 codes.

[11] **ITU-T Q.850** — formal disconnect cause codes for ISDN; mapping between Q.931 and ISUP.
     Referenced in FreeSWITCH source `src/switch_channel.c` and `include/switch_types.h`.

[12] **RFC 3398 — ISUP/SIP cause code mapping.**
     https://tools.ietf.org/html/rfc3398
     Used by FreeSWITCH `mod_sofia` (`hangup_cause_to_sip` function) for SIP-level translation.

[13] **VICIDIAL_for_Dummies PDF — recycle delay rules of thumb.**
     https://download.vicidial.com/ubuntu/VICIdial_for_Dummies_20100331.pdf

[14] **Vicidial CALLBACKS_PROCESS.txt — CBHOLD / CALLBK state-machine semantics.**
     https://github.com/inktel/Vicidial/blob/master/docs/CALLBACKS_PROCESS.txt

[15] **Five9 — abandon rate definition + DNC scrubbing.**
     https://www.five9.com/products/features/do-not-call
     Industry definition of abandon rate (callee answer to agent connect within 2s).

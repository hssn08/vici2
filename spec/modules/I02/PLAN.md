# I02 — IVR Engine — PLAN

| Field | Value |
|---|---|
| **Module** | I02 — IVR Engine (nested inbound menus, DTMF tree, prompt playback, conditional routing to I01 in-groups) |
| **Phase** | 3 (Inbound/Blended) |
| **Author** | I02-PLAN sub-agent (Claude Sonnet 4.6, 1M ctx) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator/lead review |
| **RESEARCH** | [`spec/modules/I02/RESEARCH.md`](./RESEARCH.md) — 13 sections, 6 failure modes, 6 open questions |
| **Module spec** | `spec/modules/I02.md` (this PLAN supersedes it; I02.md treated the module narrowly as "DID routing"; this PLAN adds the full IVR engine as directed by the orchestrator brief) |
| **Depends on (FROZEN)** | F03 HANDOFF §5.2 (`public` context `10_*–89_*` slot reserved for I02); F03 HANDOFF §9 (mod_xml_curl bindings empty, ready to add); I01 PLAN §15 (in-group extension naming FROZEN: `ingroup_{id}` in `dialplan/default/60_ingroup_*.xml`; I02 transfers to these); T01 PLAN §1 (`eslgo` v1.5.0, ESL primitives — `bgapi reloadxml`); D05 PLAN §0 (inbound exempt from DNC hot path; still log via call_log); C02 PLAN §1.2 (recording disclosure before queue entry; `did_numbers.recording_disclosure_audio` — I01 PLAN §3.5 added this column; I02 reads it); F02 schema (`did_numbers` with `route_kind=ivr`, `route_target`; `ingroups` PK `(tenant_id, id)`) |
| **Blocks** | I03 (IVR builder UI depends on I02 schema + renderer being stable); A05 (agent UI — inbound call preview shows IVR exit context) |

---

## 0. TL;DR — 12-bullet decision summary

1. **Phase 1: static FreeSWITCH dialplan XML, generated offline by IvrRenderer.** The API service renders the IVR tree as FS dialplan XML files, writes them to the FS config volume, and issues `bgapi reloadxml`. No round-trips during call execution. Calls proceed even if the API is down. IvrRenderer lives at `api/src/services/ivr/IvrRenderer.ts`. RESEARCH §2.1.

2. **Phase 2: Go ESL controller (`ivrbridge`).** For dynamic/conditional trees requiring per-call data (account lookups, CRM data, complex branching), a new `dialer/cmd/ivrbridge/` binary uses `eslgo` (T01's pinned library) to drive node execution over ESL. Phase 1 and Phase 2 coexist: an `ivrs.phase` flag routes calls to XML execution vs. ivrbridge. Phase 1 XML remains as fallback for ivrbridge-controlled IVRs. RESEARCH §2.3.

3. **Schema: 4 new tables + 2 additive ALTERs.** New tables: `ivrs`, `ivr_nodes`, `ivr_edges`, `ivr_prompts`, and `ivr_traversal_log` (partitioned monthly). Additive ALTERs on `did_numbers` (2 new columns: `default_lang`, `ivr_timeout_sec`). The `recording_disclosure_audio` column on `did_numbers` was already added by I01 PLAN §3.5; I02 reads it. All in a single I02 migration. PLAN §2.

4. **IVR graph model: nodes (type, prompt, collect config) + edges (digit → next node or action).** Every node is either `collect` (play prompt + collect digit) or `terminal` (execute an action with no digit collection). Every `collect` node MUST have a `timeout` edge and a `invalid_max` fallback; the renderer rejects incomplete trees. PLAN §3.

5. **Phase 1 depth cap: ≤3 levels.** DFS validation at save time. Phase 2 removes this cap. PLAN §1.2.

6. **Terminal actions: route_to_ingroup, hangup, voicemail, external_transfer, callback_offer.** `route_to_ingroup` generates `transfer ingroup_{ingroup_id} XML default` (I01's frozen extension naming). `callback_offer` schedules a D06 callback and hangs up. `voicemail` routes to I05. `external_transfer` bridges to a configured E.164 number. PLAN §4.

7. **Prompt storage: S3 + local FS cache.** Upload pipeline: admin UI → `POST /api/admin/ivr-prompts` → ffmpeg conversion → S3 put → path stored in `ivr_prompts.file_uri`. Dev: bind-mount into FS container. Prod: rclone sync sidecar. PLAN §5.

8. **Multi-language: per-node prompt variants selected by `vici2_ivr_lang` channel var.** Language set at DID entry (from `did_numbers.default_lang`) or by a `lang_select` node. Prompt resolution order: exact lang match → English fallback → system prompt. PLAN §6.

9. **DID entry point: one XML file per DID in `public` context (`10_did_{e164}.xml`).** Sets channel vars (`vici2_tenant_id`, `vici2_ivr_id`, `vici2_ivr_lang`, `vici2_role`), plays recording disclosure (`did_numbers.recording_disclosure_audio` if set), then transfers to `ivr_{id}_entry` in the `default` context. PLAN §7.

10. **Analytics: `ivr_traversal_log` table, partitioned monthly.** Phase 1 write path: HANGUP event → ESL bridge reconstructs path from channel vars → batch INSERT. Phase 2: ivrbridge writes per-node in real time. Key metrics: node entry rate, per-node drop-off, digit distribution, session completion rate. PLAN §8.

11. **Admin UI: form-based node tree editor (Phase 1); drag-drop canvas (Phase 2).** Route: `web/src/app/(admin)/ivrs/`. Phase 1 UI: tree rendered as an indented form with add/remove node controls. Phase 2: react-flow or similar drag-drop canvas. PLAN §10.

12. **Audit: every IVR config change → `audit_log`.** Covered by the existing C03 audit chain. The API's IVR save endpoints call the same `AuditLog.write()` function used by other admin operations. PLAN §11.

---

## 1. Goals and non-goals

### 1.1 Phase 3 goals (this PLAN)

| Goal | Detail |
|---|---|
| G1 | Accept inbound calls from carrier, look up DID in `did_numbers`, route to the configured IVR tree entry node |
| G2 | Execute DTMF-driven decision tree: play prompt, collect digit, branch on digit or timeout |
| G3 | Support terminal actions: route to I01 in-group, hangup with apology, voicemail (I05), external PSTN transfer, callback offer (D06) |
| G4 | Play recording consent disclosure before IVR tree for applicable DIDs (C02 contract) |
| G5 | Support ≤3 nested menu levels (Phase 1 cap; Phase 2 removes) |
| G6 | Per-node configurable prompt, collect min/max digits, timeout_ms, invalid_max |
| G7 | Multi-language IVR: per-node prompt variants; language set at DID entry or via lang_select node |
| G8 | Prompt management: upload WAV/MP3 → convert → store in S3 → validate at render time |
| G9 | Analytics: `ivr_traversal_log` with per-node entry count, drop-off, digit distribution |
| G10 | Admin UI: form-based IVR tree editor with node CRUD, prompt upload, edge configuration |
| G11 | Audit: every IVR config change logged to `audit_log` via C03 chain |
| G12 | Safe reload: `bgapi reloadxml` after every IVR save; no FS restart required |

### 1.2 Non-goals (Phase 3)

| Non-goal | Deferred to |
|---|---|
| NG1 | Trees deeper than 3 levels | Phase 2 (ivrbridge binary) |
| NG2 | Dynamic per-call data in IVR (account balance, CRM lookup mid-tree) | Phase 2 (ivrbridge) |
| NG3 | ASR / speech recognition input (non-DTMF) | Phase 4 |
| NG4 | TTS for prompt generation (all prompts are pre-recorded audio) | Phase 4 |
| NG5 | `mod_xml_curl` dynamic dialplan for IVR | Phase 2 (explicit fallback wiring point exists per F03 §9) |
| NG6 | Multi-FS topology (IvrRenderer writes to one FS volume) | Phase 4 (multi-FS) |
| NG7 | Blended IVR (inbound calls triggering outbound callbacks immediately) | I04 |
| NG8 | IVR A/B testing | Phase 4 |
| NG9 | DID provisioning / number porting | T02 (carrier module) |
| NG10 | In-group queue management inside IVR | I01 (sibling module) |

### 1.3 Deliberate refinements from I02.md module spec

I02.md described the module narrowly as "DID Inbound Routing" with `mod_xml_curl` as the execution mechanism. This PLAN supersedes that description. Key changes:

1. **IVR engine is the primary deliverable**, not just DID lookup. DID routing is the entry point; the DTMF tree is the core.
2. **Static XML (not mod_xml_curl) for Phase 1.** The I02.md spec assumed `mod_xml_curl` for dynamic lookup. This PLAN uses pre-rendered static XML. Rationale: lower latency, higher reliability, simpler debugging. mod_xml_curl is deferred to Phase 2.
3. **Schema is a proper graph model**, not a JSON blob. I02.md implied `treeJson` on the `IvrTree` table. This PLAN deprecates `ivr_trees.tree_json` in favor of the normalized `ivr_nodes` + `ivr_edges` model, which enables analytics and is required for the admin UI tree editor.

---

## 2. Schema

All tables in I02's migration (`api/prisma/migrations/<timestamp>_i02_ivr_engine/`). All tables have `tenant_id BIGINT NOT NULL DEFAULT 1` as the first composite index component (F02 PLAN §3 index convention). Reversible (up.sql + down.sql).

### 2.1 Table: `ivrs`

```sql
CREATE TABLE ivrs (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id         BIGINT NOT NULL DEFAULT 1,
  name              VARCHAR(128) NOT NULL,
  description       TEXT DEFAULT NULL,
  entry_node_id     BIGINT DEFAULT NULL
    COMMENT 'FK to ivr_nodes.id; set after first node is created',
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  phase             ENUM('xml','ivrbridge') NOT NULL DEFAULT 'xml'
    COMMENT 'xml = static dialplan; ivrbridge = Go ESL controller (Phase 2)',
  max_depth_validated TINYINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Cached max depth from last save; renderer rejects if > 3 (Phase 1)',
  created_at        DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_ivrs_t_active (tenant_id, active),
  UNIQUE KEY uk_ivrs_t_name (tenant_id, name),
  CONSTRAINT fk_ivrs_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT
);
```

**Note:** `ivr_trees` (the existing F02 table with `tree_json`) is DEPRECATED by this PLAN. It is NOT dropped in the I02 migration (backward compatibility for any existing data); it is simply unused by I02's code paths. The I02 migration adds a `deprecated=true` comment to the table via a no-op ALTER.

### 2.2 Table: `ivr_nodes`

```sql
CREATE TABLE ivr_nodes (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id       BIGINT NOT NULL DEFAULT 1,
  ivr_id          BIGINT NOT NULL,
  name            VARCHAR(128) NOT NULL
    COMMENT 'Human-readable label for admin UI (e.g., "Main Menu", "Sales Submenu")',
  node_type       ENUM(
                    'collect',        -- play prompt + collect DTMF digit(s)
                    'lang_select',    -- bilingual greeting; sets vici2_ivr_lang
                    'terminal_ingroup',     -- route_to_ingroup: transfer ingroup_{id}
                    'terminal_hangup',      -- play apology + hangup
                    'terminal_voicemail',   -- route to I05 voicemail
                    'terminal_transfer',    -- PSTN bridge to external number
                    'terminal_callback'     -- D06 callback offer
                  ) NOT NULL,
  -- DTMF collection config (for 'collect' and 'lang_select' nodes)
  collect_min     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  collect_max     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  collect_terminators VARCHAR(8) NOT NULL DEFAULT 'none'
    COMMENT '"none" for single-digit menus; "#" for multi-digit entry',
  timeout_ms      INT UNSIGNED NOT NULL DEFAULT 5000
    COMMENT 'Time to wait for first digit after prompt ends',
  inter_digit_ms  INT UNSIGNED NOT NULL DEFAULT 3000
    COMMENT 'Time to wait between digits (multi-digit only)',
  invalid_max     TINYINT UNSIGNED NOT NULL DEFAULT 3
    COMMENT 'Hangup/fallback after this many consecutive invalid inputs',
  -- Terminal action config
  action_target   VARCHAR(128) DEFAULT NULL
    COMMENT 'For terminal nodes: ingroup_id, E.164 number, voicemail_box_id, etc.',
  -- Position metadata (for admin UI rendering)
  position_x      INT NOT NULL DEFAULT 0,
  position_y      INT NOT NULL DEFAULT 0,
  created_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_ivr_nodes_t_ivr (tenant_id, ivr_id),
  CONSTRAINT fk_ivr_nodes_ivr FOREIGN KEY (ivr_id)
    REFERENCES ivrs(id) ON DELETE CASCADE,
  CONSTRAINT fk_ivr_nodes_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT
);
```

### 2.3 Table: `ivr_edges`

```sql
CREATE TABLE ivr_edges (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id       BIGINT NOT NULL DEFAULT 1,
  ivr_id          BIGINT NOT NULL,
  from_node_id    BIGINT NOT NULL,
  -- on_input semantics:
  --   digit string '0'-'9','*','#'  → exact DTMF match
  --   '__TIMEOUT__'                  → fires when read() returns empty (timeout)
  --   '__INVALID_MAX__'              → fires after invalid_max consecutive invalid inputs
  on_input        VARCHAR(16) NOT NULL,
  to_node_id      BIGINT DEFAULT NULL
    COMMENT 'NULL only for terminal edges (on_input matching a terminal from_node)',
  label           VARCHAR(64) DEFAULT NULL
    COMMENT 'Human-readable edge label for admin UI (e.g., "Press 1 for Sales")',
  sort_order      TINYINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Rendering order in branch dispatcher (lower = checked first)',
  created_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX idx_ivr_edges_t_ivr      (tenant_id, ivr_id),
  INDEX idx_ivr_edges_t_from     (tenant_id, from_node_id, on_input),
  UNIQUE KEY uk_ivr_edges_from_input (from_node_id, on_input),
  CONSTRAINT fk_ivr_edges_from   FOREIGN KEY (from_node_id)
    REFERENCES ivr_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_ivr_edges_to     FOREIGN KEY (to_node_id)
    REFERENCES ivr_nodes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ivr_edges_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT
);
```

**Edge validation rules (enforced by IvrRenderer at save time):**

- Every `collect` or `lang_select` node MUST have exactly one `__TIMEOUT__` edge and exactly one `__INVALID_MAX__` edge.
- Every digit edge for a `collect` node must have a valid `to_node_id` or the `from_node` must be terminal (which cannot have outgoing digit edges).
- No edge may create a cycle (DFS cycle check during validation).
- `to_node_id` must belong to the same `ivr_id` as the edge.

### 2.4 Table: `ivr_prompts`

```sql
CREATE TABLE ivr_prompts (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id       BIGINT NOT NULL DEFAULT 1,
  node_id         BIGINT NOT NULL,
  lang            VARCHAR(5) NOT NULL DEFAULT 'en'
    COMMENT 'BCP-47 language code: "en", "es", "fr", etc.',
  file_uri        VARCHAR(512) NOT NULL
    COMMENT 'S3 URI: s3://vici2-media/ivr/{tenant_id}/{ivr_id}/{node_id}_{lang}.wav',
  file_size_bytes INT UNSIGNED DEFAULT NULL,
  duration_ms     INT UNSIGNED DEFAULT NULL
    COMMENT 'Populated at upload time after ffprobe; used for analytics',
  created_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uk_ivr_prompts_node_lang (node_id, lang),
  INDEX idx_ivr_prompts_t_node (tenant_id, node_id),
  CONSTRAINT fk_ivr_prompts_node   FOREIGN KEY (node_id)
    REFERENCES ivr_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_ivr_prompts_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT
);
```

### 2.5 Table: `ivr_traversal_log` (partitioned monthly)

```sql
CREATE TABLE ivr_traversal_log (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id    BIGINT NOT NULL DEFAULT 1,
  ivr_id       BIGINT NOT NULL,
  session_uuid VARCHAR(40) NOT NULL,
  node_id      BIGINT NOT NULL,
  lang         VARCHAR(5) NOT NULL DEFAULT 'en',
  digit        VARCHAR(8) DEFAULT NULL
    COMMENT 'NULL on timeout; empty string on hangup during prompt',
  outcome      ENUM('digit','timeout','hangup','invalid','terminal') NOT NULL,
  duration_ms  INT UNSIGNED NOT NULL DEFAULT 0,
  entered_at   DATETIME(6) NOT NULL,
  INDEX idx_itl_t_ivr   (tenant_id, ivr_id, entered_at),
  INDEX idx_itl_t_sess  (tenant_id, session_uuid),
  INDEX idx_itl_t_node  (tenant_id, node_id, outcome, entered_at)
) PARTITION BY RANGE (TO_DAYS(entered_at)) (
  PARTITION p_2026_05 VALUES LESS THAN (TO_DAYS('2026-06-01')),
  PARTITION p_2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p_2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p_max     VALUES LESS THAN MAXVALUE
  -- O02 retention worker adds/drops partitions monthly.
);
```

### 2.6 Additive ALTER on `did_numbers`

```sql
ALTER TABLE did_numbers
  ADD COLUMN default_lang      VARCHAR(5) NOT NULL DEFAULT 'en'
    COMMENT 'Default BCP-47 language for IVR prompt selection; operator set; overridden by lang_select node',
  ADD COLUMN ivr_timeout_sec   SMALLINT UNSIGNED NOT NULL DEFAULT 300
    COMMENT 'Hard session timeout in seconds; sched_transfer to hangup if caller stuck in IVR';
-- NOTE: recording_disclosure_audio was already added by I01 PLAN §3.5.
-- I02 reads that column but does NOT re-add it.
```

### 2.7 Prisma model additions

```prisma
model Ivr {
  id                    BigInt      @id @default(autoincrement())
  tenantId              BigInt      @default(1) @map("tenant_id")
  name                  String      @db.VarChar(128)
  description           String?     @db.Text
  entryNodeId           BigInt?     @map("entry_node_id")
  active                Boolean     @default(true)
  phase                 IvrPhase    @default(xml)
  maxDepthValidated     Int         @default(0) @map("max_depth_validated") @db.TinyInt
  createdAt             DateTime    @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt             DateTime    @updatedAt @map("updated_at") @db.DateTime(6)

  tenant   Tenant      @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  nodes    IvrNode[]

  @@unique([tenantId, name], map: "uk_ivrs_t_name")
  @@index([tenantId, active], map: "idx_ivrs_t_active")
  @@map("ivrs")
}

enum IvrPhase { xml; ivrbridge }

model IvrNode {
  id                BigInt      @id @default(autoincrement())
  tenantId          BigInt      @default(1) @map("tenant_id")
  ivrId             BigInt      @map("ivr_id")
  name              String      @db.VarChar(128)
  nodeType          IvrNodeType @map("node_type")
  collectMin        Int         @default(1) @map("collect_min") @db.TinyInt
  collectMax        Int         @default(1) @map("collect_max") @db.TinyInt
  collectTerminators String     @default("none") @map("collect_terminators") @db.VarChar(8)
  timeoutMs         Int         @default(5000) @map("timeout_ms") @db.UnsignedInt
  interDigitMs      Int         @default(3000) @map("inter_digit_ms") @db.UnsignedInt
  invalidMax        Int         @default(3) @map("invalid_max") @db.TinyInt
  actionTarget      String?     @map("action_target") @db.VarChar(128)
  positionX         Int         @default(0) @map("position_x")
  positionY         Int         @default(0) @map("position_y")
  createdAt         DateTime    @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt         DateTime    @updatedAt @map("updated_at") @db.DateTime(6)

  ivr         Ivr         @relation(fields: [ivrId], references: [id], onDelete: Cascade)
  tenant      Tenant      @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  edgesFrom   IvrEdge[]   @relation("EdgeFrom")
  edgesTo     IvrEdge[]   @relation("EdgeTo")
  prompts     IvrPrompt[]

  @@index([tenantId, ivrId], map: "idx_ivr_nodes_t_ivr")
  @@map("ivr_nodes")
}

enum IvrNodeType {
  collect
  lang_select
  terminal_ingroup
  terminal_hangup
  terminal_voicemail
  terminal_transfer
  terminal_callback
}

model IvrEdge {
  id          BigInt   @id @default(autoincrement())
  tenantId    BigInt   @default(1) @map("tenant_id")
  ivrId       BigInt   @map("ivr_id")
  fromNodeId  BigInt   @map("from_node_id")
  onInput     String   @map("on_input") @db.VarChar(16)
  toNodeId    BigInt?  @map("to_node_id")
  label       String?  @db.VarChar(64)
  sortOrder   Int      @default(0) @map("sort_order") @db.TinyInt
  createdAt   DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  fromNode IvrNode  @relation("EdgeFrom", fields: [fromNodeId], references: [id], onDelete: Cascade)
  toNode   IvrNode? @relation("EdgeTo",   fields: [toNodeId],   references: [id], onDelete: Restrict)
  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@unique([fromNodeId, onInput], map: "uk_ivr_edges_from_input")
  @@index([tenantId, ivrId],        map: "idx_ivr_edges_t_ivr")
  @@index([tenantId, fromNodeId, onInput], map: "idx_ivr_edges_t_from")
  @@map("ivr_edges")
}

model IvrPrompt {
  id              BigInt   @id @default(autoincrement())
  tenantId        BigInt   @default(1) @map("tenant_id")
  nodeId          BigInt   @map("node_id")
  lang            String   @default("en") @db.VarChar(5)
  fileUri         String   @map("file_uri") @db.VarChar(512)
  fileSizeBytes   Int?     @map("file_size_bytes") @db.UnsignedInt
  durationMs      Int?     @map("duration_ms") @db.UnsignedInt
  createdAt       DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt       DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  node   IvrNode @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  tenant Tenant  @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@unique([nodeId, lang], map: "uk_ivr_prompts_node_lang")
  @@index([tenantId, nodeId], map: "idx_ivr_prompts_t_node")
  @@map("ivr_prompts")
}
```

---

## 3. IVR tree structure

### 3.1 Graph model

An IVR is a directed graph:
- **Nodes** are vertices: `collect` nodes have edges; `terminal_*` nodes have no outgoing edges.
- **Edges** are labeled by `on_input`: the digit(s) that trigger this edge, or the sentinel values `__TIMEOUT__` / `__INVALID_MAX__`.
- **Entry node** (`ivrs.entry_node_id`) is the root; every path from entry must eventually reach a terminal node.
- **Depth** = longest path from entry to any terminal. Phase 1 cap: 3.

### 3.2 Node type semantics

| Node Type | Dialplan Behavior | `action_target` |
|---|---|---|
| `collect` | Play prompt, `read` DTMF, branch on result | NULL (target defined by edges) |
| `lang_select` | Play bilingual prompt, set `vici2_ivr_lang`, branch | NULL |
| `terminal_ingroup` | `transfer ingroup_{target} XML default` | ingroup_id (e.g., `SUPPORT`) |
| `terminal_hangup` | `playback sys_goodbye.wav; hangup NORMAL_CLEARING` | NULL or custom WAV path |
| `terminal_voicemail` | `transfer voicemail_{target} XML default` (I05) | voicemail box id |
| `terminal_transfer` | `bridge sofia/gateway/${carrier}/${target}` | E.164 number (e.g., `+18005551234`) |
| `terminal_callback` | Play callback offer, D06 schedule, hangup | ingroup_id for callback queue |

### 3.3 Required edge set per collect node

| `on_input` | Purpose | Required | Notes |
|---|---|---|---|
| `'0'`–`'9'` | Digit match | At least 1 required | Multiple digit edges allowed |
| `'*'` | Star key | Optional | |
| `'#'` | Pound key | Optional | |
| `'__TIMEOUT__'` | No digit received in `timeout_ms` | MANDATORY | Renderer rejects without it |
| `'__INVALID_MAX__'` | `invalid_max` consecutive invalid inputs | MANDATORY | Renderer rejects without it |

### 3.4 Example 2-level tree

```
Entry: main_menu (collect)
  ├── '1' → sales_submenu (collect)
  │     ├── '1' → terminal_ingroup(SALES)
  │     ├── '2' → terminal_ingroup(SOLAR_SALES)
  │     ├── __TIMEOUT__ → terminal_hangup
  │     └── __INVALID_MAX__ → terminal_ingroup(SALES)  [default: route to main queue]
  ├── '2' → terminal_ingroup(SUPPORT)
  ├── '0' → terminal_ingroup(GENERAL)
  ├── __TIMEOUT__ → terminal_ingroup(GENERAL)
  └── __INVALID_MAX__ → terminal_hangup
```

This tree has depth 2 (main_menu → sales_submenu → terminal). Phase 1 cap of 3 supports one additional level (e.g., sales_submenu → region_submenu → terminal).

---

## 4. Routing actions

### 4.1 route_to_ingroup

Generates:
```xml
<action application="transfer" data="ingroup_{action_target} XML default"/>
```

`action_target` = the `ingroups.id` string (e.g., `SUPPORT`, `SALES`). The `ingroup_{id}` extension in `dialplan/default/60_ingroup_*.xml` is the FROZEN naming from I01 PLAN §15. I02 must not modify those extensions; it simply transfers to them.

Before this transfer, I02's terminal extension sets:
```xml
<action application="set" data="vici2_ivr_exit_node={node_id}"/>
<action application="set" data="vici2_ivr_exit_action=route_to_ingroup"/>
<action application="set" data="vici2_ivr_exit_target={action_target}"/>
```

These channel vars are carried into the in-group queue entry and written to `queue_calls.ivr_exit_node` (a future I01 amendment, if needed) for analytics correlation.

### 4.2 hangup

```xml
<action application="playback" data="/var/lib/freeswitch/sounds/ivr/sys/sys_goodbye.wav"/>
<action application="hangup" data="NORMAL_CLEARING"/>
```

If `action_target` is a non-null WAV path, that file is played instead of `sys_goodbye.wav`.

### 4.3 voicemail (I05)

```xml
<action application="transfer" data="voicemail_{action_target} XML default"/>
```

I05 owns the `voicemail_*` extension namespace in the `default` context. I02 transfers to it without modification.

### 4.4 external_transfer

```xml
<action application="set" data="hangup_after_bridge=true"/>
<action application="bridge" data="sofia/gateway/${default_gateway}/{action_target}"/>
```

`action_target` must be an E.164 number (validated by IvrRenderer: `^\+?[1-9]\d{7,14}$`). The `${default_gateway}` is the tenant's primary carrier gateway (read from `did_numbers.carrier_id` → `gateways` table at render time and embedded in the XML). Phase 2 enhancement: select gateway dynamically based on least-cost routing.

### 4.5 callback_offer

```xml
<action application="play_and_get_digits" data="1 1 1 8000 # /var/lib/freeswitch/sounds/ivr/sys/sys_callback_offer.wav /var/lib/freeswitch/sounds/ivr/sys/sys_invalid.wav VICI2_CB_OPT \d 1000 ^1$"/>
<action application="execute_extension" data="ivr_callback_dispatch_{node_id} XML default"/>
```

The dispatch extension:
```xml
<extension name="ivr_callback_dispatch_{node_id}">
  <condition field="${VICI2_CB_OPT}" expression="^1$">
    <!-- Caller opted in: schedule callback via API webhook -->
    <action application="set" data="vici2_callback_ingroup={action_target}"/>
    <action application="api" data="bgapi uuid_broadcast ${uuid} execute::curl http://api:3000/internal/ivr/callback_accept/${uuid}"/>
    <action application="playback" data="/var/lib/freeswitch/sounds/ivr/sys/sys_callback_confirmed.wav"/>
    <action application="hangup" data="NORMAL_CLEARING"/>
  </condition>
  <condition field="${VICI2_CB_OPT}" expression="^.*$">
    <!-- Caller declined: continue to default in-group -->
    <action application="transfer" data="ingroup_{action_target} XML default"/>
  </condition>
</extension>
```

The `POST /internal/ivr/callback_accept/{uuid}` API endpoint reads `vici2_did_e164` and `vici2_callback_ingroup` channel vars via ESL and calls `D06.schedulePriorityCallback`.

---

## 5. Prompt upload pipeline

### 5.1 Upload endpoint

```
POST /api/admin/ivrs/{ivrId}/nodes/{nodeId}/prompts
Content-Type: multipart/form-data
Fields: file (WAV or MP3, max 10 MB), lang (BCP-47 code, default 'en')
```

Pipeline:
1. Validate file type (MIME: `audio/wav`, `audio/mpeg`, `audio/x-wav`).
2. Validate file size ≤ 10 MB.
3. Convert to 8kHz mono PCM WAV: `ffmpeg -i {input} -ar 8000 -ac 1 -acodec pcm_s16le {output.wav}`.
4. Validate converted duration ≤ 120 seconds via ffprobe.
5. Upload to S3: `s3://vici2-media/ivr/{tenant_id}/{ivr_id}/{node_id}_{lang}.wav`.
6. Upsert `ivr_prompts` row (or INSERT ON DUPLICATE KEY UPDATE).
7. Return `{ uri, duration_ms, size_bytes }`.

### 5.2 S3 bucket configuration

Bucket: `vici2-media` (same as for recordings but distinct key prefix).
Region: same as tenant's primary region.
ACL: private (no public access).
Lifecycle rule: none (IVR prompts are retained indefinitely; deletion is explicit via admin UI).

### 5.3 Local sync for FS access

Dev: Docker volume mount `./freeswitch/sounds/ivr` → `/var/lib/freeswitch/sounds/ivr` (read-write; developer downloads prompts manually or via `make ivr-sync`).

Prod (Phase 2): `rclone sync s3://vici2-media/ivr /var/lib/freeswitch/sounds/ivr --transfers=4 --checksum` run every 60s via a sidecar container.

Phase 1 prod (single FS, single operator): the IVR save endpoint also writes the converted WAV directly to the FS container's volume via a Docker volume share or an internal HTTP upload endpoint on the FS container.

### 5.4 Prompt validation at render time

IvrRenderer, before generating XML, calls:
```typescript
for (const node of nonTerminalNodes) {
  const prompt = await s3.headObject({ Key: s3KeyFor(node, lang) });
  if (!prompt) throw new IvrRenderError(`Missing prompt for node ${node.id} lang=${lang}`);
}
```

If any prompt is missing, the save is rejected with HTTP 422 and a list of missing prompt URIs. The old XML remains in place unchanged.

---

## 6. Multi-language

### 6.1 Language set at DID entry

```xml
<action application="set" data="vici2_ivr_lang={did_numbers.default_lang}"/>
```

Default: `en`. Set via `did_numbers.default_lang` (Phase 1 default; override via `lang_select` node).

### 6.2 `lang_select` node type

A `lang_select` node is treated identically to a `collect` node in dialplan generation, with one additional action prepended to each edge:

```xml
<!-- Edge '1': set English -->
<condition field="${ivr_digit_{node_id}}" expression="^1$">
  <action application="set" data="vici2_ivr_lang=en"/>
  <action application="transfer" data="ivr_{id}_n{to_node_id} XML default"/>
</condition>
<!-- Edge '2': set Spanish -->
<condition field="${ivr_digit_{node_id}}" expression="^2$">
  <action application="set" data="vici2_ivr_lang=es"/>
  <action application="transfer" data="ivr_{id}_n{to_node_id} XML default"/>
</condition>
```

The `lang_select` node itself must have at least one language edge and both `__TIMEOUT__` and `__INVALID_MAX__` edges.

### 6.3 Prompt resolution at render time

The IvrRenderer resolves prompts for each node using:
```
1. ivr_prompts WHERE node_id = N AND lang = '${vici2_ivr_lang}'  (static check — each lang variant generates a separate playback action under a condition)
2. ivr_prompts WHERE node_id = N AND lang = 'en'                  (English fallback)
3. /var/lib/freeswitch/sounds/ivr/sys/sys_invalid.wav              (last resort)
```

In Phase 1, the XML generator outputs a condition tree per node that checks `${vici2_ivr_lang}` and plays the matching file:
```xml
<extension name="ivr_{id}_n{node_id}">
  <condition field="destination_number" expression="^ivr_{id}_n{node_id}$">
    <!-- Language-conditional prompt -->
    <condition field="${vici2_ivr_lang}" expression="^es$">
      <action application="playback" data="/var/lib/freeswitch/sounds/ivr/t1/{ivr_id}/{node_id}_es.wav"/>
    </condition>
    <condition field="${vici2_ivr_lang}" expression="^(?!es).*$">
      <action application="playback" data="/var/lib/freeswitch/sounds/ivr/t1/{ivr_id}/{node_id}_en.wav"/>
    </condition>
    <action application="read" data="1 1 '' ivr_digit_{node_id} 5000 none"/>
    <action application="execute_extension" data="ivr_{id}_n{node_id}_branch XML default"/>
  </condition>
</extension>
```

---

## 7. Dialplan generator

### 7.1 IvrRenderer service

Location: `api/src/services/ivr/IvrRenderer.ts`

```typescript
class IvrRenderer {
  // Main entry point: called on every IVR save (create or update)
  async render(ivrId: bigint): Promise<void>

  // Validates tree: no cycles, all prompts exist, all targets valid, depth ≤ 3
  private async validate(ivr: IvrWithNodes): Promise<void>

  // Generates default context XML for all nodes
  private generateDefaultXml(ivr: IvrWithNodes): string

  // Generates public context DID entry XML for all DIDs routing to this IVR
  private async generatePublicXml(ivr: IvrWithNodes): Promise<DIDPublicXml[]>

  // Writes XML files atomically (tmp file + rename)
  private async writeXml(filePath: string, content: string): Promise<void>

  // Issues bgapi reloadxml via T01 ESL connection
  private async reloadXml(): Promise<void>
}
```

### 7.2 File naming

| File | Location | Trigger |
|---|---|---|
| `70_ivr_{id}.xml` | `freeswitch/conf/dialplan/default/` | IVR save |
| `10_did_{e164_digits}.xml` | `freeswitch/conf/dialplan/public/` | IVR save OR DID route change |

The `10_` prefix is chosen for DID files within the I02-reserved range (`10_*–89_*`). All I02 DID files use prefix `10_`. IVR node definitions go in the `default` context under prefix `70_` (non-conflicting with I01's `60_ingroup_*.xml`).

### 7.3 Reload after save

```typescript
await this.writeXml(defaultPath, defaultXml);
await this.writeXml(publicPath, publicXml);
await eslClient.bgapi('reloadxml');
// Wait for reloadxml ACK (BACKGROUND_JOB event with +OK)
```

The ESL `bgapi reloadxml` is idempotent and non-disruptive per F03 HANDOFF §2. Total reload time: < 500ms for typical FS config sizes.

### 7.4 XML generation for collect node

Complete generated output for a single collect node with 2 digit edges + timeout + invalid_max:

```xml
<!-- === Node {node_id}: {name} === -->
<extension name="ivr_{ivr_id}_n{node_id}" continue="false">
  <condition field="destination_number" expression="^ivr_{ivr_id}_n{node_id}$">
    <action application="set" data="vici2_ivr_node_id={node_id}"/>
    <!-- Append node to path -->
    <action application="set" data="vici2_ivr_path=${vici2_ivr_path}:{node_id}"/>
    <!-- Language-conditional prompt playback -->
    <action application="playback" data="{prompt_path_for_current_lang}"/>
    <!-- DTMF collection -->
    <action application="read" data="{collect_min} {collect_max} '' ivr_digit_{node_id} {timeout_ms} {terminators}"/>
    <!-- Branch -->
    <action application="execute_extension" data="ivr_{ivr_id}_n{node_id}_branch XML default"/>
  </condition>
</extension>

<!-- === Branch dispatcher for node {node_id} === -->
<extension name="ivr_{ivr_id}_n{node_id}_branch" continue="false">
  <!-- Edge: digit '1' -->
  <condition field="${ivr_digit_{node_id}}" expression="^1$" break="on-true">
    <action application="set" data="vici2_ivr_digits=${vici2_ivr_digits}:1"/>
    <action application="transfer" data="ivr_{ivr_id}_n{to_node_id_for_1} XML default"/>
  </condition>
  <!-- Edge: digit '2' -->
  <condition field="${ivr_digit_{node_id}}" expression="^2$" break="on-true">
    <action application="set" data="vici2_ivr_digits=${vici2_ivr_digits}:2"/>
    <action application="transfer" data="ivr_{ivr_id}_n{to_node_id_for_2} XML default"/>
  </condition>
  <!-- Edge: timeout (empty read result) -->
  <condition field="${ivr_digit_{node_id}}" expression="^$" break="on-true">
    <action application="transfer" data="ivr_{ivr_id}_n{timeout_to_node_id} XML default"/>
  </condition>
  <!-- Edge: invalid input -->
  <condition field="${ivr_digit_{node_id}}" expression="^.*$" break="on-true">
    <action application="set" data="ivr_invalid_count=${expr(${ivr_invalid_count}+1)}"/>
    <action application="execute_extension" data="ivr_{ivr_id}_n{node_id}_invalid_check XML default"/>
  </condition>
</extension>

<!-- === Invalid count check for node {node_id} === -->
<extension name="ivr_{ivr_id}_n{node_id}_invalid_check" continue="false">
  <!-- invalid_max reached: go to __INVALID_MAX__ target -->
  <condition field="${ivr_invalid_count}" expression="^([{invalid_max}-9]|[1-9][0-9]+)$" break="on-true">
    <action application="set" data="ivr_invalid_count=0"/>
    <action application="transfer" data="{invalid_max_target} XML default"/>
  </condition>
  <!-- Not yet: replay this node -->
  <condition field="${ivr_invalid_count}" expression="^.*$" break="on-true">
    <action application="transfer" data="ivr_{ivr_id}_n{node_id} XML default"/>
  </condition>
</extension>
```

---

## 8. Analytics

### 8.1 Phase 1 write path

On HANGUP_COMPLETE event received by `eslbridge`:
1. Read channel vars: `vici2_ivr_id`, `vici2_ivr_path`, `vici2_ivr_digits`, `vici2_ivr_lang`.
2. Parse `vici2_ivr_path` (colon-delimited node ID list) and `vici2_ivr_digits` (colon-delimited digit list).
3. POST to `http://api:3000/internal/ivr/traversal_log` with JSON body:
   ```json
   {
     "session_uuid": "{call_uuid}",
     "ivr_id": "{ivr_id}",
     "lang": "{lang}",
     "path": ["{node_id}", ...],
     "digits": ["{digit}", ...],
     "final_outcome": "terminal|hangup|timeout",
     "total_duration_ms": "{call_duration}"
   }
   ```
4. API endpoint batch-INSERTs into `ivr_traversal_log` (one row per node).

### 8.2 Channel var size limit

FS per-channel-var size is effectively unlimited for short strings. A 3-level IVR with node IDs up to 10 digits generates a path string of `"12345678901:12345678902:12345678903"` ≈ 36 chars. Well within FS channel var limits.

### 8.3 Admin analytics endpoints

```
GET /api/admin/ivrs/{id}/analytics?from=2026-05-01&to=2026-05-31
```

Response:
```json
{
  "session_count": 1234,
  "completion_rate": 0.82,
  "nodes": [
    {
      "node_id": "12",
      "name": "Main Menu",
      "entry_count": 1234,
      "drop_off_count": 47,
      "drop_off_rate": 0.038,
      "digit_distribution": { "1": 623, "2": 401, "0": 163 },
      "timeout_count": 89,
      "avg_duration_ms": 4320
    }
  ]
}
```

---

## 9. API endpoints

All routes under `api/src/routes/admin/ivr.ts` (and one internal route for ESL hooks).

### 9.1 Admin endpoints

```
# IVR CRUD
GET    /api/admin/ivrs                          → list IVRs for tenant
POST   /api/admin/ivrs                          → create IVR (triggers render)
GET    /api/admin/ivrs/:ivrId                   → get IVR with nodes + edges + prompts
PUT    /api/admin/ivrs/:ivrId                   → update IVR metadata (rename, toggle active)
DELETE /api/admin/ivrs/:ivrId                   → soft-delete IVR (sets active=false; removes DID XML; reloadxml)

# IVR Node CRUD
POST   /api/admin/ivrs/:ivrId/nodes             → create node (triggers full re-render)
PUT    /api/admin/ivrs/:ivrId/nodes/:nodeId     → update node config (triggers re-render)
DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId     → delete node + its edges (triggers re-render)

# IVR Edge CRUD
POST   /api/admin/ivrs/:ivrId/nodes/:nodeId/edges       → create edge (triggers re-render)
PUT    /api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId → update edge (triggers re-render)
DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId → delete edge (triggers re-render)

# Prompt upload
POST   /api/admin/ivrs/:ivrId/nodes/:nodeId/prompts     → upload prompt file (WAV/MP3)
DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId/prompts/:promptId → delete prompt

# Analytics
GET    /api/admin/ivrs/:ivrId/analytics         → traversal stats (§8.3)

# DID assignment
PUT    /api/admin/did-numbers/:didId/ivr        → assign IVR to DID (sets route_kind=ivr, route_target=ivrId)
```

### 9.2 Internal endpoints (ESL/FS hooks)

```
POST  /api/internal/ivr/traversal_log           → write traversal log rows from eslbridge
POST  /api/internal/ivr/callback_accept/:uuid   → D06 callback scheduling triggered by FS
```

Both internal endpoints are authenticated via the same HTTP basic auth as `mod_xml_curl` (env `FS_XMLCURL_USER` / `FS_XMLCURL_PASS`, per F03 HANDOFF §9).

---

## 10. Admin UI

### 10.1 Phase 1: form-based tree editor

Route: `web/src/app/(admin)/ivrs/`

Pages:
- `/ivrs` — list of IVRs with name, active status, node count, DID assignments.
- `/ivrs/new` — create IVR (name + entry point selection deferred to post-first-node-save).
- `/ivrs/{id}` — IVR detail: tree rendered as indented accordion form.
  - Each node shown as a card: type selector, name field, collect config fields (min/max/timeout/invalid_max).
  - Prompt upload per node per language: file input + preview player (HTML5 audio).
  - Edge list per node: digit input + target node selector (dropdown of all nodes in this IVR) OR terminal action selector.
  - "Add node" and "Add edge" buttons per node card.
  - "Save & Deploy" button: calls PUT/POST endpoints + shows render result (success/error + missing prompt list).

### 10.2 Phase 2: drag-drop canvas

`react-flow` (MIT license; production-ready as of 2026) renders the IVR as a node-edge diagram. Nodes are drag-repositioned (`position_x`, `position_y` columns persist the layout). Edges are drawn by dragging from node handle to node. Terminal actions shown as colored terminal nodes.

Phase 2 UI is a separate feature flag (`FEATURE_IVR_CANVAS=true`); Phase 1 form editor remains available.

---

## 11. Audit

Every IVR write operation (create, update, delete IVR/node/edge/prompt) calls:
```typescript
await auditLog.write({
  tenantId,
  userId: req.user.id,
  action: 'ivr.node.create',   // or ivr.create, ivr.edge.update, etc.
  entityType: 'ivr_node',
  entityId: node.id,
  before: beforeSnapshot,
  after: afterSnapshot,
});
```

This uses the existing C03 audit chain. The `audit_log` table already has `entity_type` as a lookup table; I02's migration seeds the new entity type rows: `ivr`, `ivr_node`, `ivr_edge`, `ivr_prompt`.

Every `reloadxml` that follows an IVR change also writes:
```typescript
await auditLog.write({
  action: 'ivr.dialplan.rendered',
  metadata: { ivr_id, rendered_at, file_path, node_count }
});
```

---

## 12. Files to create

```
# Schema + migrations
api/prisma/migrations/<timestamp>_i02_ivr_engine/migration.sql

# IVR renderer service
api/src/services/ivr/IvrRenderer.ts
api/src/services/ivr/IvrValidator.ts
api/src/services/ivr/XmlBuilder.ts
api/src/services/ivr/PromptUploader.ts

# API routes
api/src/routes/admin/ivr.ts
api/src/routes/internal/ivr-hooks.ts

# Shared types
shared/types/src/ivr.ts          # IVR tree types; node/edge/prompt types; analytics response

# FS dialplan templates (static, for system prompts not generated by renderer)
freeswitch/sounds/ivr/sys/sys_goodbye.wav
freeswitch/sounds/ivr/sys/sys_invalid.wav
freeswitch/sounds/ivr/sys/sys_timeout.wav
freeswitch/sounds/ivr/sys/sys_callback_offer.wav
freeswitch/sounds/ivr/sys/sys_callback_confirmed.wav

# Admin UI — Phase 1 form editor
web/src/app/(admin)/ivrs/page.tsx              # IVR list
web/src/app/(admin)/ivrs/[id]/page.tsx         # IVR detail / tree editor
web/src/app/(admin)/ivrs/[id]/NodeCard.tsx     # Node form component
web/src/app/(admin)/ivrs/[id]/EdgeRow.tsx      # Edge form row component
web/src/app/(admin)/ivrs/[id]/PromptUpload.tsx # Prompt upload + preview component
web/src/app/(admin)/ivrs/new/page.tsx          # Create IVR form

# Tests
api/test/ivr/IvrRenderer.test.ts               # Unit: XML generation for all node types
api/test/ivr/IvrValidator.test.ts              # Unit: cycle detection, missing edges, depth cap
api/test/ivr/ivr-routes.test.ts               # Integration: API CRUD + render trigger
api/test/ivr/ivr-analytics.test.ts             # Integration: traversal log + analytics query

# Go Phase 2 stub (empty binary, Phase 2 IMPLEMENT fills)
dialer/cmd/ivrbridge/main.go                   # Stub: logs "ivrbridge not yet implemented (Phase 2)"
```

---

## 13. Test plan

### 13.1 Unit tests

| Test | File | Fixture |
|---|---|---|
| IvrValidator: rejects tree with cycle | `IvrValidator.test.ts` | A→B→A edge |
| IvrValidator: rejects tree missing `__TIMEOUT__` edge | `IvrValidator.test.ts` | collect node, no timeout edge |
| IvrValidator: rejects tree missing `__INVALID_MAX__` edge | `IvrValidator.test.ts` | collect node, no invalid_max edge |
| IvrValidator: rejects tree with depth > 3 | `IvrValidator.test.ts` | 4-level linear chain |
| IvrValidator: accepts minimal valid tree (1 collect + 1 terminal) | `IvrValidator.test.ts` | collect → terminal_ingroup |
| XmlBuilder: collect node generates correct `read` args | `IvrRenderer.test.ts` | node with collect_min=1, collect_max=1, timeout=5000 |
| XmlBuilder: branch dispatcher generates correct conditions | `IvrRenderer.test.ts` | 3-digit node |
| XmlBuilder: terminal_ingroup generates `transfer ingroup_{id}` | `IvrRenderer.test.ts` | action_target='SUPPORT' |
| XmlBuilder: terminal_hangup plays sys_goodbye and hangs up | `IvrRenderer.test.ts` | — |
| XmlBuilder: lang_select sets vici2_ivr_lang on each edge | `IvrRenderer.test.ts` | 2-language node |
| XmlBuilder: multi-lang playback generates language condition | `IvrRenderer.test.ts` | node with en+es prompts |
| IvrRenderer: rejects save on missing S3 prompt | `IvrRenderer.test.ts` | S3 headObject mock returns 404 |
| IvrRenderer: writes tmp file + renames atomically | `IvrRenderer.test.ts` | filesystem mock |
| IvrRenderer: issues bgapi reloadxml after write | `IvrRenderer.test.ts` | ESL mock |

### 13.2 Integration tests (API)

| Test | HTTP | Expected |
|---|---|---|
| Create IVR → 201, renders XML | `POST /api/admin/ivrs` | XML file written, reloadxml called |
| Add collect node with edges → re-renders | `POST /api/admin/ivrs/1/nodes` + edges | Updated XML, no old node refs |
| Add terminal_ingroup node pointing to valid ingroup → 201 | `POST .../nodes` | OK |
| Add terminal_ingroup pointing to non-existent ingroup → 422 | `POST .../nodes` | `{"error": "ingroup 'FAKE' not found"}` |
| Save IVR with missing prompt → 422 | `PUT /api/admin/ivrs/1` | `{"error": "missing prompts: [...]}` |
| Upload WAV prompt → 200, S3 stored | `POST .../prompts` | `{ uri, duration_ms }` |
| Upload MP3 prompt → 200, converted to WAV | `POST .../prompts` | `{ uri, duration_ms }` |
| Upload oversized file (11 MB) → 413 | `POST .../prompts` | HTTP 413 |
| Delete IVR → public XML removed, reloadxml | `DELETE /api/admin/ivrs/1` | File deleted, reload |
| Analytics endpoint returns correct counts | `GET /api/admin/ivrs/1/analytics` | JSON with node stats |

### 13.3 Acceptance scenarios (SIPp or manual)

| Scenario | Steps | Expected |
|---|---|---|
| S1: Single-level menu, press 1 → SUPPORT queue | Dial DID; hear prompt; press 1 | Call enters SUPPORT in-group queue (I01) |
| S2: Single-level menu, press 2 → SALES queue | Dial DID; hear prompt; press 2 | Call enters SALES in-group queue |
| S3: Two-level menu, press 1 then press 1 → SOLAR_SALES | Dial DID; press 1 (submenu); press 1 | Routes to SOLAR_SALES in-group |
| S4: Timeout → hangup (GENERAL fallback) | Dial DID; hear prompt; wait 5s | Call falls to GENERAL in-group per timeout edge |
| S5: 3 invalid inputs → hangup | Press 9, 8, 7 (all invalid) | Plays apology, hangs up |
| S6: Language select: press 2 for Spanish | Press 2 on lang_select node | Subsequent prompts play Spanish WAV |
| S7: IVR runaway protection | Stay silent > 300s | sched_transfer fires, graceful goodbye + hangup |
| S8: Missing prompt fallback | Remove prompt file; dial | Silence during prompt; DTMF still works; no crash |
| S9: Callback offer terminal | Press 1 on callback_offer node | D06 callback scheduled; confirmation TTS; hangup |
| S10: Recording disclosure plays before IVR | DID has recording_disclosure_audio set | Disclosure WAV plays before IVR entry node |
| S11: Analytics logged after call | Complete scenario S1 | `ivr_traversal_log` has rows for all visited nodes |
| S12: DID with route_kind=ingroup (not ivr) | Dial non-IVR DID | Not routed through IVR; goes directly to I01 |

---

## 14. Acceptance criteria

- [ ] AC1: A 3-level DTMF IVR tree can be created, saved, and deployed without FS restart.
- [ ] AC2: All 5 terminal action types (ingroup, hangup, voicemail, external_transfer, callback_offer) route calls correctly.
- [ ] AC3: Invalid input counter increments correctly; after `invalid_max` invalid inputs, the configured fallback fires.
- [ ] AC4: Timeout edge fires when no digit is entered within `timeout_ms`.
- [ ] AC5: `bgapi reloadxml` is issued after every IVR save; new callers see the new tree within 2 seconds.
- [ ] AC6: Recording disclosure WAV plays before IVR entry if `did_numbers.recording_disclosure_audio` is set.
- [ ] AC7: Multi-language IVR plays correct language prompt based on `vici2_ivr_lang`.
- [ ] AC8: `ivr_traversal_log` rows are inserted for every session; per-node analytics are correct.
- [ ] AC9: IVR save is rejected (422) if any prompt file is missing from S3.
- [ ] AC10: IVR save is rejected (422) if the tree has depth > 3 (Phase 1 cap).
- [ ] AC11: IVR save is rejected (422) if the tree contains a cycle.
- [ ] AC12: IVR save is rejected (422) if any collect node is missing a `__TIMEOUT__` or `__INVALID_MAX__` edge.
- [ ] AC13: `ivr_timeout_sec` hard cap fires: caller stuck in IVR is hungup after the configured timeout.
- [ ] AC14: Every IVR config change (node/edge/prompt CRUD) is written to `audit_log`.
- [ ] AC15: Deleting an IVR removes its dialplan XML files and issues reloadxml; calls to that DID get 503 (or route to F03's catchall).

---

## 15. Dependencies and risks

### 15.1 Dependencies

| Dependency | What I02 needs | Status |
|---|---|---|
| F03 HANDOFF §5.2 | `public` context `10_*–89_*` file range reserved for I02 | FROZEN |
| I01 PLAN §15 | `ingroup_{id}` extension naming in `default` context | FROZEN |
| T01 PLAN §1 | ESL `bgapi reloadxml` primitive; `eslgo` v1.5.0 | FROZEN |
| F02 schema | `did_numbers` with `route_kind=ivr`, `route_target` | DONE |
| C02 PLAN §1.2 | `did_numbers.recording_disclosure_audio` col (added by I01 PLAN §3.5) | PLAN-stable |
| D06 | `schedulePriorityCallback` (for callback_offer terminal) | PLAN-stable |
| I05 | `voicemail_{id}` extension naming (for terminal_voicemail) | NOT_STARTED — I02 uses a placeholder extension name; I05 must match |
| O02 | Monthly partition management for `ivr_traversal_log` | PLAN-stable |

### 15.2 Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| R1: S3 sync latency in prod (prompt not yet on FS disk when call arrives) | Medium | Medium — caller hears silence | Pre-validate at render time; rclone sync interval ≤ 60s; alert on missing files |
| R2: `reloadxml` race (FS reads partially-written XML) | Low | High — FS crashes or misconfigures | Atomic tmp→rename write (§7.3); FS processes the full file after rename |
| R3: Channel var path string overflow (deep trees) | Low (Phase 1 depth=3) | Low | Path string ≤ 36 chars for 3-level trees; Phase 2 ivrbridge writes per-node to DB directly |
| R4: I05 voicemail extension naming not yet frozen | Medium | Medium — `terminal_voicemail` cannot be tested end-to-end | Use placeholder `voicemail_placeholder_{target}` in Phase 1; update after I05 PLAN |
| R5: D06 callback_accept HTTP call from FS dialplan (`api bgapi uuid_broadcast curl`) | Medium | Medium — `api` app in FS can call HTTP; requires FS `api` app enabled | Verify FS has `mod_commands` loaded (it does per F03 PLAN §8); alternatively move to ESL-triggered webhook from eslbridge on DTMF event |
| R6: IVR tree editor UI complexity (Phase 1 form vs Phase 2 canvas) | Low | Low | Phase 1 form editor is explicitly limited; Phase 2 is a separate feature flag |
| R7: Multi-FS topology breaks single-volume IvrRenderer assumption | Low (Phase 1 single FS) | High (Phase 4) | Document the assumption; Phase 4 multi-FS IvrRenderer writes to each FS host volume |

### 15.3 Risk R5 mitigation detail

The `terminal_callback` node uses `<action application="api" data="bgapi uuid_broadcast ...">` to trigger a curl to the internal API. This requires the FS `api` command (mod_commands) to be loaded, which it is per F03 PLAN §8. However, the `curl` command within `uuid_broadcast execute::curl` is FS's built-in `curl` in `mod_http_cache` or `mod_curl`. F03 may not have `mod_curl` loaded.

**Safe alternative (recommended):** Instead of FS-side curl, the `terminal_callback` extension simply sets channel vars (`vici2_callback_ingroup`, `vici2_callback_requested=true`) and hangs up. The `eslbridge`, on receiving HANGUP_COMPLETE with `vici2_callback_requested=true`, issues the `POST /internal/ivr/callback_accept/{uuid}` itself. This removes any dependency on FS-side HTTP and is more consistent with the architecture (ESL bridge is the FS↔API integration point, not FS-side curl). **PLAN adopts this alternative.**

Revised `terminal_callback` dialplan:
```xml
<extension name="ivr_{id}_n{node_id}" continue="false">
  <condition field="destination_number" expression="^ivr_{id}_n{node_id}$">
    <action application="play_and_get_digits" data="1 1 1 8000 # {callback_prompt} {invalid_prompt} VICI2_CB_OPT \d 1000 ^1$"/>
    <action application="set" data="vici2_callback_ingroup={action_target}"/>
    <action application="set" data="vici2_callback_requested=${VICI2_CB_OPT}"/>
    <action application="playback" data="{goodbye_or_confirm_prompt}"/>
    <action application="hangup" data="NORMAL_CLEARING"/>
  </condition>
</extension>
```

`eslbridge` HANGUP_COMPLETE handler:
```go
if event.GetHeader("variable_vici2_callback_requested") == "1" {
    ingroup := event.GetHeader("variable_vici2_callback_ingroup")
    callerID := event.GetHeader("Caller-ANI")
    api.ScheduleCallback(ctx, sessionUUID, callerID, ingroup)
}
```

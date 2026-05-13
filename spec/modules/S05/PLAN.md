# S05 — Supervisor Coaching Tools — PLAN

**Module:** S05  
**Author:** S05-PLAN sub-agent (Claude Sonnet 4.6)  
**Date:** 2026-05-13  
**Status:** PROPOSED — awaiting orchestrator/human review  
**Companion:** [RESEARCH.md](./RESEARCH.md) — 9 sections, industry baselines + design decisions  
**Track:** Supervisor  
**Phase:** 3  
**Effort estimate:** 7–9 days  

**Dependencies (must be done or stubbed before S05 implements):**
- R03 — Recording playback API + wavesurfer.js player (the review page extends R03 detail)
- N01 — Notifications hub (agent.feedback.new, agent.scorecard.new) — N01 is Phase 4; S05 will fire notifications via the `notifications` table directly if N01 API is not yet available
- M02 — RBAC enforcement middleware (new verbs added; M02 golden-table must be regenerated)
- M03 — Agent productivity reports (S05 adds coaching_stats sub-object to M03 response)
- D04 — Dispositions (disposition code visible on review-call page; scorecard search can filter by disposition)
- S04 — Supervisor recording browser (S05 "Open for Review" action links from S04 recording list)

---

## 1. Goals and Non-Goals

### 1.1 Phase 1 Goals (S05 delivery)

1. **Scorecard templates** — admin can create/edit/version weighted hybrid scorecard templates scoped to a tenant.
2. **Call review page** — supervisor opens a completed call, plays audio (via R03 player), places timestamped annotations, fills in a scorecard form, saves draft, and finalizes.
3. **Annotation panel** — annotations synced with R03 wavesurfer.js audio player; click annotation pin → seek player to that timestamp.
4. **Scorecard finalization** — once finalized, scorecard is locked; agent receives notification; supervisor cannot edit except via admin override.
5. **Agent feedback messages** — supervisor can attach a free-text coaching note to any scorecard or independently; delivered to agent's feedback inbox.
6. **Agent feedback inbox** — agent reads own scorecards, annotations, and feedback; acknowledges feedback (immutable acknowledgment).
7. **Trend reporting** — avg scorecard per agent over date range; integrated as coaching_stats into M03 agent productivity endpoint.
8. **RBAC** — new verbs: `scorecard:read`, `scorecard:create`, `scorecard:finalize`, `scorecard:template_edit`; `feedback:read`, `feedback:create`; matrix entries for supervisor / agent / admin roles.
9. **Calibration scaffold** — `scorecard_calibration_sessions` and `scorecard_calibration_assignments` tables created in migration; all calibration API endpoints return 501; `is_calibration` flag functional.
10. **Notifications** — insert into `notifications` table on scorecard finalization and new feedback; N01 integration wired once N01 ships.

### 1.2 Non-Goals (deferred)

- **Live coaching** (real-time text to agent during call) — Phase 3 (requires S02 / A03 / T01).
- **Agent self-evaluation** (agent scores own call before seeing supervisor scores) — Phase 2.
- **Calibration full workflow** (session management, blind reveal, IRA report) — Phase 2.
- **Dispute resolution** (agent disputes a criterion score) — Phase 2.
- **AI auto-scoring from N07 transcript** — Phase 4.
- **PDF export** of scorecard + annotations — Phase 2.
- **Screen recording side-by-side** — Phase 3+ (no screen capture in Vici2 Phase 1).
- **Coaching appointments** (scheduled formal sessions, Genesys-style) — Phase 3.
- **GDPR erasure of scorecard PII** — Phase 4 (legal-hold worker).

---

## 2. Schema

### 2.1 `scorecard_templates`

```sql
CREATE TABLE scorecard_templates (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  parent_id     BIGINT UNSIGNED  NULL COMMENT 'NULL = root version; set when template is versioned',
  version       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  name          VARCHAR(128)     NOT NULL,
  description   TEXT             NULL,
  criteria      JSON             NOT NULL COMMENT 'Array of ScorecardCriterion (see §2.5)',
  active        TINYINT(1)       NOT NULL DEFAULT 1,
  created_by    BIGINT UNSIGNED  NULL,
  created_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at    DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_sct_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_sct_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_sct_parent  FOREIGN KEY (parent_id) REFERENCES scorecard_templates(id) ON DELETE SET NULL,
  KEY idx_sct_t_active (tenant_id, active, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Versioning rule:** editing an active template (one with finalized scorecards pointing to it) creates a new row with `parent_id = old.id`, `version = old.version + 1`, and the old template is soft-archived (`active = 0`). This preserves historical scorecard fidelity. Zero-finalized-scorecard templates can be edited in-place.

**Criteria JSON validation** (enforced at API layer):
- Array of 1..50 objects.
- Each object: `{ id: uuid, label: string, type: 'numeric'|'binary'|'auto_fail'|'text_only', weight: number, max_score: number, section?: string, auto_fail?: bool, na_eligible?: bool }`.
- Sum of `weight` values across non-`text_only` criteria must equal 100.0 ± 0.01.
- `auto_fail` criteria must have `type='auto_fail'` and `weight=0`.
- `text_only` criteria must have `weight=0` and `max_score=0`.
- `max_score` must be ≥ 1 for `numeric` and `binary`, exactly 1 for `binary` and `auto_fail`.

**Prisma model (to add to schema.prisma):**

```prisma
model ScorecardTemplate {
  id          BigInt    @id @default(autoincrement())
  tenantId    BigInt    @default(1) @map("tenant_id")
  parentId    BigInt?   @map("parent_id")
  version     Int       @default(1)
  name        String    @db.VarChar(128)
  description String?   @db.Text
  criteria    Json
  active      Boolean   @default(true)
  createdBy   BigInt?   @map("created_by")
  createdAt   DateTime  @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.DateTime(6)

  tenant    Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  parent    ScorecardTemplate? @relation("TemplateVersions", fields: [parentId], references: [id], onDelete: SetNull)
  children  ScorecardTemplate[] @relation("TemplateVersions")
  creator   User?              @relation(fields: [createdBy], references: [id], onDelete: SetNull)
  scorecards CallScorecard[]

  @@index([tenantId, active], map: "idx_sct_t_active")
  @@map("scorecard_templates")
}
```

---

### 2.2 `call_scorecards`

```sql
CREATE TABLE call_scorecards (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  call_uuid      VARCHAR(40)      NOT NULL,
  template_id    BIGINT UNSIGNED  NOT NULL,
  supervisor_id  BIGINT UNSIGNED  NULL COMMENT 'NULL if deleted user',
  agent_id       BIGINT UNSIGNED  NULL COMMENT 'NULL if call had no agent (edge case)',
  campaign_id    VARCHAR(32)      NULL,
  scores         JSON             NOT NULL COMMENT 'Array of {criterion_id, score, na: bool, comment}',
  total_score    DECIMAL(5,2)     NOT NULL DEFAULT 0.00 COMMENT '0..100, computed on save',
  comments       TEXT             NULL COMMENT 'Overall evaluation comment',
  status         ENUM('draft','finalized') NOT NULL DEFAULT 'draft',
  is_calibration TINYINT(1)       NOT NULL DEFAULT 0,
  finalized_at   DATETIME(6)      NULL,
  created_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_cs_tenant    FOREIGN KEY (tenant_id)   REFERENCES tenants(id)              ON DELETE CASCADE,
  CONSTRAINT fk_cs_template  FOREIGN KEY (template_id) REFERENCES scorecard_templates(id)  ON DELETE RESTRICT,
  CONSTRAINT fk_cs_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id)             ON DELETE SET NULL,
  CONSTRAINT fk_cs_agent     FOREIGN KEY (agent_id)    REFERENCES users(id)                ON DELETE SET NULL,
  KEY idx_cs_t_agent         (tenant_id, agent_id, created_at),
  KEY idx_cs_t_template      (tenant_id, template_id, status, created_at),
  KEY idx_cs_t_call_uuid     (tenant_id, call_uuid),
  KEY idx_cs_t_supervisor    (tenant_id, supervisor_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Score computation rules (in `ScorecardService.computeTotal()`):**

```typescript
function computeTotal(criteria: ScorecardCriterion[], scores: ScoreEntry[]): number {
  // 1. Check auto_fail first
  const autoFailCriteria = criteria.filter(c => c.auto_fail);
  for (const c of autoFailCriteria) {
    const entry = scores.find(s => s.criterion_id === c.id);
    if (entry && entry.score === 0 && !entry.na) return 0.0;
  }
  // 2. Weighted sum, with NA re-normalization
  const scoringCriteria = criteria.filter(c => c.type !== 'text_only' && !c.auto_fail);
  const naIds = new Set(scores.filter(s => s.na).map(s => s.criterion_id));
  const activeWeight = scoringCriteria
    .filter(c => !naIds.has(c.id))
    .reduce((acc, c) => acc + c.weight, 0);
  if (activeWeight === 0) return 0.0;
  let total = 0;
  for (const c of scoringCriteria) {
    if (naIds.has(c.id)) continue;
    const entry = scores.find(s => s.criterion_id === c.id);
    const score = entry?.score ?? 0;
    const normalizedWeight = c.weight / activeWeight * 100;
    total += (score / c.max_score) * normalizedWeight;
  }
  return Math.round(total * 100) / 100; // 2dp
}
```

**Prisma model:**

```prisma
model CallScorecard {
  id             BigInt    @id @default(autoincrement())
  tenantId       BigInt    @default(1) @map("tenant_id")
  callUuid       String    @map("call_uuid") @db.VarChar(40)
  templateId     BigInt    @map("template_id")
  supervisorId   BigInt?   @map("supervisor_id")
  agentId        BigInt?   @map("agent_id")
  campaignId     String?   @map("campaign_id") @db.VarChar(32)
  scores         Json
  totalScore     Decimal   @default(0.00) @map("total_score") @db.Decimal(5, 2)
  comments       String?   @db.Text
  status         ScorecardStatus @default(draft)
  isCalibration  Boolean   @default(false) @map("is_calibration")
  finalizedAt    DateTime? @map("finalized_at") @db.DateTime(6)
  createdAt      DateTime  @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.DateTime(6)

  tenant      Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  template    ScorecardTemplate @relation(fields: [templateId], references: [id], onDelete: Restrict)
  supervisor  User?             @relation("ScorecardSupervisor", fields: [supervisorId], references: [id], onDelete: SetNull)
  agent       User?             @relation("ScorecardAgent", fields: [agentId], references: [id], onDelete: SetNull)
  annotations CallAnnotation[]
  feedback    AgentFeedback[]

  @@index([tenantId, agentId, createdAt], map: "idx_cs_t_agent")
  @@index([tenantId, templateId, status, createdAt], map: "idx_cs_t_template")
  @@index([tenantId, callUuid], map: "idx_cs_t_call_uuid")
  @@map("call_scorecards")
}

enum ScorecardStatus {
  draft
  finalized
}
```

---

### 2.3 `call_annotations`

```sql
CREATE TABLE call_annotations (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id      BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  call_uuid      VARCHAR(40)      NOT NULL,
  scorecard_id   BIGINT UNSIGNED  NULL COMMENT 'NULL if standalone annotation not linked to a scorecard',
  supervisor_id  BIGINT UNSIGNED  NULL,
  timestamp_ms   INT UNSIGNED     NOT NULL COMMENT 'Milliseconds from call start (synced with audio player)',
  text           TEXT             NOT NULL,
  tag            ENUM('positive','needs_improvement','training_opportunity','compliance_flag','praise') NOT NULL DEFAULT 'needs_improvement',
  created_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_ca_tenant     FOREIGN KEY (tenant_id)    REFERENCES tenants(id)         ON DELETE CASCADE,
  CONSTRAINT fk_ca_scorecard  FOREIGN KEY (scorecard_id) REFERENCES call_scorecards(id) ON DELETE SET NULL,
  CONSTRAINT fk_ca_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id)          ON DELETE SET NULL,
  KEY idx_ca_t_call (tenant_id, call_uuid, timestamp_ms),
  KEY idx_ca_scorecard (scorecard_id, timestamp_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Prisma model:**

```prisma
model CallAnnotation {
  id            BigInt    @id @default(autoincrement())
  tenantId      BigInt    @default(1) @map("tenant_id")
  callUuid      String    @map("call_uuid") @db.VarChar(40)
  scorecardId   BigInt?   @map("scorecard_id")
  supervisorId  BigInt?   @map("supervisor_id")
  timestampMs   Int       @map("timestamp_ms")
  text          String    @db.Text
  tag           AnnotationTag @default(needs_improvement)
  createdAt     DateTime  @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.DateTime(6)

  tenant     Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  scorecard  CallScorecard? @relation(fields: [scorecardId], references: [id], onDelete: SetNull)
  supervisor User?          @relation(fields: [supervisorId], references: [id], onDelete: SetNull)

  @@index([tenantId, callUuid, timestampMs], map: "idx_ca_t_call")
  @@index([scorecardId, timestampMs], map: "idx_ca_scorecard")
  @@map("call_annotations")
}

enum AnnotationTag {
  positive
  needs_improvement
  training_opportunity
  compliance_flag
  praise
}
```

---

### 2.4 `agent_feedback`

```sql
CREATE TABLE agent_feedback (
  id                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tenant_id            BIGINT UNSIGNED  NOT NULL DEFAULT 1,
  agent_id             BIGINT UNSIGNED  NOT NULL,
  supervisor_id        BIGINT UNSIGNED  NULL,
  related_scorecard_id BIGINT UNSIGNED  NULL,
  related_call_uuid    VARCHAR(40)      NULL,
  body                 TEXT             NOT NULL,
  acknowledged_at      DATETIME(6)      NULL COMMENT 'NULL until agent clicks Acknowledge; immutable once set',
  created_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at           DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_af_tenant    FOREIGN KEY (tenant_id)    REFERENCES tenants(id)         ON DELETE CASCADE,
  CONSTRAINT fk_af_agent     FOREIGN KEY (agent_id)     REFERENCES users(id)           ON DELETE CASCADE,
  CONSTRAINT fk_af_supervisor FOREIGN KEY (supervisor_id) REFERENCES users(id)         ON DELETE SET NULL,
  CONSTRAINT fk_af_scorecard FOREIGN KEY (related_scorecard_id) REFERENCES call_scorecards(id) ON DELETE SET NULL,
  KEY idx_af_t_agent         (tenant_id, agent_id, created_at),
  KEY idx_af_t_supervisor    (tenant_id, supervisor_id, created_at),
  KEY idx_af_t_unack         (tenant_id, agent_id, acknowledged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Prisma model:**

```prisma
model AgentFeedback {
  id                  BigInt    @id @default(autoincrement())
  tenantId            BigInt    @default(1) @map("tenant_id")
  agentId             BigInt    @map("agent_id")
  supervisorId        BigInt?   @map("supervisor_id")
  relatedScorecardId  BigInt?   @map("related_scorecard_id")
  relatedCallUuid     String?   @map("related_call_uuid") @db.VarChar(40)
  body                String    @db.Text
  acknowledgedAt      DateTime? @map("acknowledged_at") @db.DateTime(6)
  createdAt           DateTime  @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt           DateTime  @updatedAt @map("updated_at") @db.DateTime(6)

  tenant    Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  agent     User           @relation("FeedbackAgent", fields: [agentId], references: [id], onDelete: Cascade)
  supervisor User?         @relation("FeedbackSupervisor", fields: [supervisorId], references: [id], onDelete: SetNull)
  scorecard  CallScorecard? @relation(fields: [relatedScorecardId], references: [id], onDelete: SetNull)

  @@index([tenantId, agentId, createdAt], map: "idx_af_t_agent")
  @@index([tenantId, supervisorId, createdAt], map: "idx_af_t_supervisor")
  @@index([tenantId, agentId, acknowledgedAt], map: "idx_af_t_unack")
  @@map("agent_feedback")
}
```

---

### 2.5 Calibration Scaffold Tables (Phase 1 — stubbed, 501 endpoints)

```sql
CREATE TABLE scorecard_calibration_sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    BIGINT UNSIGNED NOT NULL DEFAULT 1,
  name         VARCHAR(128)    NOT NULL,
  template_id  BIGINT UNSIGNED NOT NULL,
  moderator_id BIGINT UNSIGNED NULL,
  deadline_at  DATETIME(6)     NULL,
  status       ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at   DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_calib_t (tenant_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE scorecard_calibration_assignments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id    BIGINT UNSIGNED NOT NULL,
  call_uuid     VARCHAR(40)     NOT NULL,
  evaluator_id  BIGINT UNSIGNED NULL,
  scorecard_id  BIGINT UNSIGNED NULL COMMENT 'Set once evaluator submits',
  created_at    DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_calib_assign_session (session_id, call_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 3. UI: Review-Call Page

### 3.1 Page: `(sup)/coaching/calls/[callUuid]/review`

This page **extends** R03 recording detail by wrapping the R03 player component inside a three-panel coaching layout:

```
┌──────────────────────────────────────────────────────────────────┐
│ [← Back to Recordings]   Agent: Jane Smith   Call: 2026-04-12   │
├──────────────────────────┬───────────────────────────────────────┤
│  AUDIO PLAYER (full-w)   │                                       │
│  [wavesurfer waveform]   │                                       │
│  ██░░░░░░░░░░░░░░░▐▌░░  │                                       │
│  00:42 / 04:17           │                                       │
├──────────────────────────┤       SCORECARD FORM (right panel)    │
│  ANNOTATION PANEL        │                                       │
│  (scrollable list,       │       Template: [Customer Service v2] │
│   sorted by timestamp)   │                                       │
│  ● 00:42 [+improve] Did  │       Section: Opening                │
│    not use agent script  │         ● Greeted with script  [4/5]  │
│  ● 01:15 [praise] Great  │         ● Offered name         [1/1]  │
│    empathy response      │                                       │
│  [+ Add annotation]      │       Section: Resolution             │
│                          │         ● Offered resolution   [3/5]  │
│                          │         ● Empathy shown        [5/5]  │
│                          │                                       │
│                          │       TOTAL SCORE: 74.2 / 100         │
│                          │                                       │
│                          │       Overall comment: [textarea]     │
│                          │                                       │
│                          │       [Save Draft]  [Finalize]        │
├──────────────────────────┴───────────────────────────────────────┤
│  FEEDBACK TO AGENT (collapsible)                                  │
│  [Send coaching note to Jane...]  [Send Feedback]                │
└──────────────────────────────────────────────────────────────────┘
```

**Responsive behavior:**
- On screens ≥ 1280px: three-column layout (annotation | player+scorecard).
- On screens < 1280px: tabs — "Player + Annotations" / "Scorecard" / "Feedback".

### 3.2 Data fetching (Next.js RSC + client component boundary)

```typescript
// (sup)/coaching/calls/[callUuid]/review/page.tsx
// RSC: fetches call metadata, recording URL (via R03 signed-URL endpoint), 
//      existing annotations, existing scorecard draft, available templates
// Client boundary: ReviewShell.tsx handles all interactive state

async function ReviewPage({ params }: { params: { callUuid: string } }) {
  const [call, recordingUrl, annotations, scorecard, templates] = await Promise.all([
    fetchCall(params.callUuid),           // GET /api/sup/coaching/calls/:uuid
    fetchRecordingUrl(params.callUuid),   // GET /api/admin/recordings/:id/url (R03)
    fetchAnnotations(params.callUuid),    // GET /api/sup/coaching/calls/:uuid/annotations
    fetchScorecard(params.callUuid),      // GET /api/sup/coaching/calls/:uuid/scorecard
    fetchTemplates(),                     // GET /api/sup/coaching/templates
  ]);
  return <ReviewShell {...{ call, recordingUrl, annotations, scorecard, templates }} />;
}
```

---

## 4. Annotation Editor Synced with R03 Audio Playback

### 4.1 WaveSurfer integration

R03 uses wavesurfer.js. S05 adds a Markers plugin layer. The `AnnotatedPlayer` component:

```typescript
// web/src/components/coaching/AnnotatedPlayer.tsx
'use client';
import WaveSurfer from 'wavesurfer.js';
import Markers from 'wavesurfer.js/dist/plugins/markers';

interface AnnotatedPlayerProps {
  audioUrl: string;
  annotations: Annotation[];
  onAddAnnotation: (timestampMs: number) => void;
  onAnnotationClick: (annotation: Annotation) => void;
  readOnly?: boolean;
}
```

**Annotation pin rendering:**
- Each annotation is rendered as a colored `<div>` absolutely positioned on the waveform at `(timestampMs / durationMs) * 100%`.
- Color by tag: positive=green, needs_improvement=amber, training_opportunity=blue, compliance_flag=red, praise=emerald.
- Clicking a pin calls `wavesurfer.seekTo(annotation.timestampMs / totalDurationMs)` and highlights the annotation in the list panel.

**Adding an annotation:**
- Keyboard shortcut `A` or toolbar button "Add Annotation" drops a pin at `wavesurfer.getCurrentTime() * 1000` (ms).
- A popover opens at the pin position: `<textarea>` for text + `<select>` for tag.
- On submit → `POST /api/sup/coaching/calls/:uuid/annotations` → pin appears.

### 4.2 Annotation list panel

Sorted by `timestamp_ms` ascending. Each row:
```
[colored dot] [HH:MM:SS]  [tag badge]
[annotation text — up to 2 lines truncated]
[Edit] [Delete]   (hidden in read-only mode)
```

Clicking any row calls the seek function. Edit opens the same popover pre-filled.

**Mutability rules:**
- Supervisor can edit/delete own annotations while scorecard is in `draft` status.
- Once scorecard is `finalized`, annotations are locked. Admin can unlock via `POST /api/admin/coaching/scorecards/:id/unlock` (returns scorecard to draft, logged as audit event).

---

## 5. Scorecard Form: Weighted Fields, Auto-Compute Total, Draft / Finalize

### 5.1 Template selection

On first load (no existing scorecard), supervisor selects a template from a dropdown. Templates filtered by `active=true` for the tenant. On selection, the criteria JSON is rendered as the form body.

### 5.2 Criterion rendering by type

| Criterion type | Input rendered |
|---|---|
| `numeric` | Slider 0..max_score with numeric display + optional N/A checkbox |
| `binary` | Toggle (Yes=max_score / No=0) + optional N/A checkbox (if na_eligible) |
| `auto_fail` | Toggle (Pass / FAIL). Toggling FAIL turns total score display red |
| `text_only` | Textarea only (no score input) |

### 5.3 Auto-compute total

Total score recomputes on every criterion change using `computeTotal()` (see §2.2) running client-side. Displayed prominently below the form as `XX.X / 100` with color coding:
- ≥ 90: green
- 75–89: blue
- 60–74: amber
- < 60: red

### 5.4 Save draft

`PATCH /api/sup/coaching/calls/:uuid/scorecard` with `{ status: 'draft', scores, comments }`. Draft can be saved and resumed. Draft is visible only to the creating supervisor (and admin).

### 5.5 Finalize

`PATCH /api/sup/coaching/calls/:uuid/scorecard` with `{ status: 'finalized' }`. Server:
1. Validates all required criteria have a score or N/A (text_only excluded).
2. Recomputes total_score server-side (do not trust client value).
3. Sets `finalized_at = NOW()`.
4. Locks all associated annotations.
5. Inserts a `notifications` row for the agent: `category='coaching.scorecard.new'`, `link=/feedback/scorecards/:id`.
6. Emits audit log: `coaching.scorecard.finalized`.

---

## 6. Agent UI: View Own Scorecards + Feedback, Acknowledge Feedback

### 6.1 Page: `(agent)/feedback`

```
┌─────────────────────────────────────────────────────┐
│ My Feedback Inbox                    [2 unread]      │
│                                                      │
│ Tabs: [Feedback Notes (8)] [Scorecards (14)]         │
│                                                      │
│ ─ Feedback Notes ─────────────────────────────────  │
│ [!] Apr 12 — Supervisor: John Kim                    │
│     "Great empathy on the Smith call. Work on       │
│      opening script adherence."                     │
│     [View Call Recording]  [Acknowledge]             │
│                                                      │
│ ✓ Apr 08 — Supervisor: Maria Chen                    │
│     "Excellent closing technique."                   │
│     Acknowledged Apr 09                              │
└─────────────────────────────────────────────────────┘
```

### 6.2 Page: `(agent)/feedback/scorecards/[id]`

Agent read-only view of a finalized scorecard:
- Audio player (via R03 signed URL) with annotation pins (read-only mode).
- Scorecard criteria with their scores and the supervisor's criterion comments.
- Total score prominently displayed.
- Overall comment.
- "Acknowledge" button for any unacknowledged linked feedback.

### 6.3 Acknowledge API

`PATCH /api/agent/feedback/:id/acknowledge`
- RBAC: `feedback:read` with `scope=own` (agent can only acknowledge their own feedback).
- Sets `acknowledged_at = NOW()` if currently NULL. Returns 409 if already acknowledged.
- Immutable: no endpoint to un-acknowledge.
- Audit log: `coaching.feedback.acknowledged`.

---

## 7. Notifications via the Notifications Table

S05 inserts into the `notifications` table directly (no dependency on N01 service being live):

| Event | `category` | `subject` | `link` |
|---|---|---|---|
| Scorecard finalized | `coaching.scorecard.new` | `"New evaluation from <supervisor>"` | `(agent)/feedback/scorecards/:id` |
| Feedback created | `coaching.feedback.new` | `"Feedback from <supervisor>"` | `(agent)/feedback` |

Both notifications are `severity=info`, `channel=in_app`. When N01 is implemented, it will pick up these notification rows for email delivery without any S05 code change (N01 polls/subscribes to the `notifications` table).

---

## 8. Reporting: Avg Scorecard Per Agent Over Date Range

### 8.1 Trend endpoint

`GET /api/sup/coaching/reports/agent-trend`

Query parameters: `agent_id`, `template_id`, `from` (ISO date), `to` (ISO date), `interval` (day|week|month).

Response:

```json
{
  "agent_id": 123,
  "agent_name": "Jane Smith",
  "template_id": 7,
  "template_name": "Customer Service v2",
  "period": { "from": "2026-03-01", "to": "2026-04-30" },
  "data_points": [
    { "date": "2026-03-01", "avg_score": 78.2, "eval_count": 3 },
    { "date": "2026-03-08", "avg_score": 80.5, "eval_count": 4 }
  ],
  "summary": {
    "avg_score": 79.4,
    "total_evaluations": 14,
    "trend_delta": 2.3,
    "evaluations_by_tag": {
      "needs_improvement": 12,
      "positive": 8,
      "compliance_flag": 1
    }
  }
}
```

### 8.2 M03 integration: coaching_stats sub-object

`GET /api/sup/reports/agents/:id/productivity` (M03 endpoint) gains a `coaching_stats` field:

```typescript
interface CoachingStats {
  evaluations_received: number;
  avg_scorecard_score: number | null;  // null if no finalized scorecards in period
  feedback_items: number;
  unacknowledged_feedback: number;
  trend_7d_delta: number | null;       // score delta vs 7 days prior; null if insufficient data
}
```

M03 queries `call_scorecards` with `is_calibration=0` and `status='finalized'` for the agent+period.

### 8.3 Team summary endpoint

`GET /api/sup/coaching/reports/team-summary?campaign_id=&template_id=&from=&to=`

Returns per-agent averages for all agents in supervisor's group. Used by supervisor coaching dashboard.

---

## 9. RBAC: New Verbs and Matrix Entries

### 9.1 New verbs (to add to `shared/types/src/rbac.ts`)

```typescript
// Scoring / coaching
'scorecard:read',          // view scorecards for agents in scope
'scorecard:create',        // create/save draft scorecard
'scorecard:finalize',      // finalize a draft scorecard (locks it)
'scorecard:template_edit', // create / edit / version scorecard templates
'feedback:read',           // view feedback for agents in scope (or self)
'feedback:create',         // create feedback notes
```

### 9.2 Matrix assignments

| Verb | super_admin | admin | supervisor | agent | viewer |
|---|---|---|---|---|---|
| `scorecard:read` | tenant | tenant | group | own | tenant |
| `scorecard:create` | tenant | tenant | group | — | — |
| `scorecard:finalize` | tenant | tenant | group | — | — |
| `scorecard:template_edit` | tenant | tenant | — | — | — |
| `feedback:read` | tenant | tenant | group | own | — |
| `feedback:create` | tenant | tenant | group | — | — |

**Scope semantics:**
- `own` for agent: agent can read scorecards where `agent_id = self.id` and status = `finalized`.
- `group` for supervisor: supervisor can read/create scorecards where `agent_id IN (agents in supervisor's user_group)`.
- `tenant` for admin: all scorecards in tenant.

**Sensitive verbs:** `scorecard:finalize` is added to `SENSITIVE_VERBS` (triggers audit row on allow). `scorecard:template_edit` is also sensitive.

### 9.3 M02 golden-table regeneration

After adding the 6 new verbs to `rbac.ts`, run `make gen-rbac` to regenerate `dialer/internal/auth/rbac/matrix_gen.go` and update `test/rbac/golden.json`. The M02 CI gate will catch any drift.

---

## 10. API Endpoints

### 10.1 Supervisor coaching endpoints (`/api/sup/coaching/`)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/sup/coaching/templates` | `scorecard:read` / `scorecard:create` | List active templates for tenant |
| GET | `/api/sup/coaching/calls/:uuid` | `scorecard:read` | Call metadata + recording info for review page |
| GET | `/api/sup/coaching/calls/:uuid/annotations` | `scorecard:read` | All annotations for a call_uuid |
| POST | `/api/sup/coaching/calls/:uuid/annotations` | `scorecard:create` | Create annotation |
| PATCH | `/api/sup/coaching/calls/:uuid/annotations/:id` | `scorecard:create` | Edit annotation (draft only) |
| DELETE | `/api/sup/coaching/calls/:uuid/annotations/:id` | `scorecard:create` | Delete annotation (draft only) |
| GET | `/api/sup/coaching/calls/:uuid/scorecard` | `scorecard:read` | Get scorecard (draft or finalized) for call |
| POST | `/api/sup/coaching/calls/:uuid/scorecard` | `scorecard:create` | Create scorecard for call (draft status) |
| PATCH | `/api/sup/coaching/calls/:uuid/scorecard` | `scorecard:create` | Update draft scorecard |
| POST | `/api/sup/coaching/calls/:uuid/scorecard/finalize` | `scorecard:finalize` | Finalize scorecard (lock, notify agent) |
| POST | `/api/sup/coaching/calls/:uuid/feedback` | `feedback:create` | Send feedback note to agent |
| GET | `/api/sup/coaching/agents/:agentId/scorecards` | `scorecard:read` | List scorecards for a specific agent |
| GET | `/api/sup/coaching/agents/:agentId/feedback` | `feedback:read` | List feedback for a specific agent |
| GET | `/api/sup/coaching/reports/agent-trend` | `scorecard:read` | Scorecard trend data (see §8.1) |
| GET | `/api/sup/coaching/reports/team-summary` | `scorecard:read` | Team avg scores (see §8.3) |

### 10.2 Admin template management endpoints (`/api/admin/coaching/`)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/admin/coaching/templates` | `scorecard:template_edit` | List all templates (including inactive, all versions) |
| POST | `/api/admin/coaching/templates` | `scorecard:template_edit` | Create new template |
| GET | `/api/admin/coaching/templates/:id` | `scorecard:template_edit` | Get template detail with criteria |
| PATCH | `/api/admin/coaching/templates/:id` | `scorecard:template_edit` | Edit template (triggers versioning if has finalized scorecards) |
| DELETE | `/api/admin/coaching/templates/:id` | `scorecard:template_edit` | Soft-deactivate template |
| POST | `/api/admin/coaching/scorecards/:id/unlock` | `scorecard:template_edit` | Admin: revert finalized scorecard to draft (emergency) |

### 10.3 Agent feedback inbox endpoints (`/api/agent/`)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/agent/feedback` | `feedback:read` scope=own | List own feedback notes |
| GET | `/api/agent/feedback/:id` | `feedback:read` scope=own | Get feedback detail |
| PATCH | `/api/agent/feedback/:id/acknowledge` | `feedback:read` scope=own | Acknowledge feedback (sets acknowledged_at) |
| GET | `/api/agent/scorecards` | `scorecard:read` scope=own | List own finalized scorecards |
| GET | `/api/agent/scorecards/:id` | `scorecard:read` scope=own | Get scorecard detail (with annotations) |

### 10.4 Calibration stub endpoints (all return 501)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/admin/coaching/calibrations` | Phase 2 |
| GET | `/api/admin/coaching/calibrations` | Phase 2 |
| GET | `/api/admin/coaching/calibrations/:id` | Phase 2 |
| POST | `/api/admin/coaching/calibrations/:id/close` | Phase 2 |

---

## 11. File Structure

```
api/src/
  routes/
    sup/
      coaching/
        index.ts                  # Route registration
        handlers/
          templates.ts            # GET /sup/coaching/templates
          calls.ts                # GET /sup/coaching/calls/:uuid
          annotations.ts          # CRUD /sup/coaching/calls/:uuid/annotations
          scorecards.ts           # GET/POST/PATCH /sup/coaching/calls/:uuid/scorecard
          finalize.ts             # POST /sup/coaching/calls/:uuid/scorecard/finalize
          feedback.ts             # POST /sup/coaching/calls/:uuid/feedback
          reports.ts              # GET /sup/coaching/reports/*
    admin/
      coaching/
        index.ts
        handlers/
          templates.ts            # CRUD /admin/coaching/templates
          unlock.ts               # POST /admin/coaching/scorecards/:id/unlock
          calibrations.ts         # Stub → 501
    agent/
      feedback/
        index.ts
        handlers/
          list.ts                 # GET /agent/feedback
          detail.ts               # GET /agent/feedback/:id
          acknowledge.ts          # PATCH /agent/feedback/:id/acknowledge
          scorecards.ts           # GET /agent/scorecards + GET /agent/scorecards/:id

  services/
    coaching/
      scorecard-service.ts        # computeTotal(), validate(), create(), update(), finalize()
      annotation-service.ts       # CRUD; lock enforcement
      feedback-service.ts         # create(), acknowledge()
      template-service.ts         # CRUD; versioning logic; criteria validation
      coaching-report-service.ts  # agent-trend, team-summary; M03 coaching_stats

  test/
    coaching/
      scorecard-service.test.ts   # computeTotal() unit tests (auto_fail, NA, weights)
      template-service.test.ts    # criteria validation tests (weight sum, types)
      annotation-service.test.ts  # lock enforcement tests
      feedback-service.test.ts    # acknowledge idempotency tests
      handlers.test.ts            # route handler integration tests

api/prisma/
  migrations/
    20260513260000_s05_coaching/
      migration.sql               # scorecard_templates, call_scorecards, call_annotations,
                                  # agent_feedback, calibration scaffold tables
      down.sql                    # rollback

web/src/
  app/
    (sup)/
      coaching/
        page.tsx                  # Coaching hub: recent reviews, team summary
        templates/
          page.tsx                # Template list (supervisor read-only view)
        calls/
          [callUuid]/
            review/
              page.tsx            # RSC shell (see §3.2)
      agents/
        [agentId]/
          coaching/
            page.tsx              # Per-agent coaching history (supervisor view)
    (agent)/
      feedback/
        page.tsx                  # Agent feedback inbox
        scorecards/
          [id]/
            page.tsx              # Agent scorecard detail (read-only)
    (admin)/
      coaching/
        templates/
          page.tsx                # Template management (admin)
          [id]/
            page.tsx              # Template editor
            edit/
              page.tsx

  components/
    coaching/
      AnnotatedPlayer.tsx         # Extends R03 RecordingPlayer with annotation pins
      AnnotationPanel.tsx         # Scrollable list of annotations with seek-on-click
      AnnotationPopover.tsx       # Add/edit annotation popover
      ScorecardForm.tsx           # Template-driven scorecard form with live total
      CriterionInput.tsx          # Per-criterion input (numeric/binary/auto_fail/text)
      ScoreDisplay.tsx            # Total score badge with color coding
      FeedbackComposer.tsx        # Feedback text input + send button
      FeedbackCard.tsx            # Agent feedback inbox card with acknowledge button
      TeamSummaryTable.tsx        # Team avg score table for supervisor dashboard
      AgentTrendChart.tsx         # Sparkline chart (recharts) for scorecard trend
      TemplateEditor.tsx          # Admin template CRUD with criteria drag-sort
      CriterionEditor.tsx         # Per-criterion editor row in TemplateEditor

  test/
    coaching.spec.ts              # Playwright e2e: review-call flow, agent inbox flow
```

---

## 12. Test Plan

### 12.1 Unit tests (Node.js `--test`)

**`scorecard-service.test.ts`** (~25 test cases):
- `computeTotal()` — all numeric criteria, weight sum = 100 → expect correct weighted avg.
- `computeTotal()` — auto_fail criterion scores 0 → expect total = 0 regardless of other scores.
- `computeTotal()` — 2 of 5 criteria marked N/A → weights re-normalized to 100 among active 3.
- `computeTotal()` — all criteria text_only → expect total = 0.
- `computeTotal()` — binary criterion yes → max_score; no → 0.
- Finalize: draft → finalized succeeds; finalized → finalized = 409 Conflict.
- Finalize: not all required criteria scored → 422.
- Save draft: missing scores treated as 0 (not error) → total recomputed.

**`template-service.test.ts`** (~15 test cases):
- Criteria weight sum = 99.5 → 422.
- Criteria weight sum = 100.01 → 422 (±0.01 tolerance means 100.00–100.01 accepted but >100.01 rejected).
- auto_fail criterion with weight > 0 → 422.
- text_only criterion with weight > 0 → 422.
- Template with 0 scoring criteria → 422.
- Template with 51 criteria → 422 (max 50).
- Edit template with finalized scorecards → new version created; old template archived.
- Edit template with only draft scorecards → in-place update (no new version).

**`annotation-service.test.ts`** (~10 test cases):
- Edit annotation on draft scorecard → success.
- Edit annotation on finalized scorecard → 403 (locked).
- Admin unlock → scorecard returns to draft → annotation editable again.
- Timestamp_ms > call duration_ms → 422 (server validates against call duration).
- > 200 annotations per call → 429.

**`feedback-service.test.ts`** (~8 test cases):
- Acknowledge feedback → sets acknowledged_at.
- Acknowledge already-acknowledged → 409.
- Agent A cannot acknowledge Agent B's feedback → 403.

### 12.2 Integration / route handler tests

Using the standard api test harness (Fastify inject):
- Full review-call flow: create draft scorecard, add 3 annotations, finalize → check notification inserted, annotations locked.
- Agent reads own scorecard: correct data, no draft scorecard visible.
- Supervisor group-scoped: supervisor from Group A cannot read scorecard for agent in Group B → 403.

### 12.3 Playwright e2e (`web/test/coaching.spec.ts`)

1. **Supervisor review flow:**
   - Log in as supervisor, navigate to S04 recording list.
   - Click "Review" on a call → review-call page opens.
   - Audio player renders; add 2 annotations at specific timestamps.
   - Select template; score all criteria; observe total score update live.
   - Save draft; reload page; draft persists.
   - Finalize; confirm lock message; notification appears in agent's inbox.

2. **Agent feedback inbox flow:**
   - Log in as agent; navigate to `/feedback`.
   - Unacknowledged feedback shows badge.
   - Open feedback → scorecard detail with annotation pins.
   - Click annotation pin → audio player seeks to timestamp.
   - Click "Acknowledge" → badge disappears; button disabled.

3. **Admin template management:**
   - Create new template with 3 criteria; validate weight sum UI guard.
   - Save; template appears in supervisor dropdown.
   - Edit template after a finalized scorecard exists → version bump dialog; confirm → new version active.

---

## 13. Acceptance Criteria

- [ ] Supervisor can open any completed call recording via the review-call page.
- [ ] Audio player renders waveform (via wavesurfer.js); seek works.
- [ ] Supervisor can add/edit/delete annotations before scorecard finalization; annotations display as colored pins on waveform.
- [ ] Clicking an annotation pin seeks the audio to that timestamp.
- [ ] Scorecard form renders all criterion types (numeric, binary, auto_fail, text_only) from the selected template.
- [ ] Total score auto-computes on every change; auto_fail at zero zeroes the total.
- [ ] N/A marking re-normalizes weights correctly.
- [ ] Draft scorecard persists across page reloads.
- [ ] Finalizing a scorecard locks annotations and scorecard; inserts notification for agent.
- [ ] Agent receives in-app notification; opens feedback inbox; views finalized scorecard with read-only annotations.
- [ ] Agent acknowledges feedback; acknowledgment is recorded and irreversible.
- [ ] Supervisor sees acknowledgment status on feedback they sent.
- [ ] `GET /api/sup/coaching/reports/agent-trend` returns correct per-day averages filtered to is_calibration=0.
- [ ] M03 `/api/sup/reports/agents/:id/productivity` includes `coaching_stats` with correct counts.
- [ ] RBAC: agent cannot access another agent's scorecards (403); supervisor cannot access agents outside their group (403); admin can access all.
- [ ] Calibration stub endpoints return 501.
- [ ] Admin template editor: weight sum validation prevents saving templates where scoring criteria weights ≠ 100.
- [ ] Audit log: `coaching.scorecard.finalized`, `coaching.feedback.acknowledged`, `coaching.scorecard.unlocked` (admin unlock).
- [ ] All 25+ unit tests pass; all 3 Playwright flows pass.

---

## 14. Dependencies and Risks

### 14.1 Hard dependencies

| Dependency | Risk if absent | Mitigation |
|---|---|---|
| R03 (recording player + signed URL) | Review-call page cannot show audio | R03 must ship before S05; S05 builds on R03 player component |
| `wavesurfer.js` markers API stability | Annotation pins may not render | Pin to wavesurfer.js 7.x; custom div-based fallback if plugin regressed |
| M02 RBAC (`make gen-rbac`) | New verbs not enforced | Run `make gen-rbac` as part of S05 migration; CI golden-table gate catches drift |
| Prisma schema changes | DB migration must land before routes deploy | Migration is atomic; rollback SQL provided |

### 14.2 Soft dependencies (can ship without, with degraded experience)

| Dependency | Degraded behavior | Note |
|---|---|---|
| S04 (supervisor recording browser) | "Open for Review" shortcut unavailable; supervisor must navigate manually | Acceptable; direct URL still works |
| N01 (notifications service) | Agent receives in-app notification only (no email) | S05 inserts into `notifications` table; N01 picks up when it ships |
| N07 (transcription) | Transcript panel not shown on review page | Transcript panel conditionally renders if transcript exists; no data = hidden |
| M03 (agent productivity reports) | `coaching_stats` not surfaced in M03 | M03 endpoint can be extended non-breaking when S05 ships |

### 14.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WaveSurfer markers plugin incompatibility | Low | High | Use wavesurfer.js 7.x Markers plugin (tested); fallback to absolute-positioned divs over canvas |
| Scorecard total computation drift between client and server | Medium | Medium | Server always recomputes on finalize; client-side is display-only; values compared on finalize — mismatch shown as warning |
| Template versioning complexity | Medium | Medium | Version only on save-with-finalized-scorecards path; zero-scorecard templates editable in place (simple case) |
| RBAC group-scope query performance | Low | Low | `call_scorecards` indexed on `(tenant_id, agent_id, created_at)`; group membership join is small (users in group typically < 50) |
| Agent notification spam on scorecard finalization | Low | Low | One notification per scorecard finalization; no debounce needed |
| Large number of annotations (> 100 per call) | Low | Low | Soft cap 200; the waveform rendering uses absolutely-positioned divs, not SVG — linear render cost |

### 14.4 Migration notes

**Migration file:** `api/prisma/migrations/20260513260000_s05_coaching/migration.sql`

Creates:
1. `scorecard_templates` (with `parent_id` self-referential FK)
2. `call_scorecards` (FK to templates, users, tenants)
3. `call_annotations` (FK to scorecards, users, tenants)
4. `agent_feedback` (FK to scorecards, users, tenants)
5. `scorecard_calibration_sessions` (scaffold)
6. `scorecard_calibration_assignments` (scaffold)
7. Enum types: `ScorecardStatus`, `AnnotationTag`

**Rollback:** `down.sql` drops all 6 tables + enums in reverse FK order.

**Prisma schema.prisma** additions: 4 new models (ScorecardTemplate, CallScorecard, CallAnnotation, AgentFeedback) + 2 scaffold models + 2 enums + relation back-references on User and Tenant.

**`shared/types/src/rbac.ts`** additions: 6 new verbs; matrix entries for super_admin, admin, supervisor, agent, viewer.

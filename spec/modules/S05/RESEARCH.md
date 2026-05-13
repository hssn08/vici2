# S05 — Supervisor Coaching Tools — RESEARCH

**Module:** S05  
**Author:** S05-PLAN sub-agent (Claude Sonnet 4.6)  
**Date:** 2026-05-13  
**Status:** RESEARCH COMPLETE — feeding into PLAN.md  

---

## 1. Industry Baselines: Five9 / Genesys / NICE Coaching Modules

### 1.1 Five9 Quality Management (QM)

Five9's QM suite (native to their cloud contact-center platform) ships the following coaching-relevant capabilities:

**Scorecard engine:**
- Templates are defined per campaign or globally at the tenant level.
- Each template contains weighted criteria grouped into sections (Opening, Discovery, Resolution, Compliance, Closing). Weights sum to 100%.
- Scorecards can be applied to calls post-hoc by any QA-authorized evaluator.
- "Auto-fail" criteria: a single criterion can be marked mandatory such that scoring 0 on it yields an automatic overall score of 0 regardless of other scores.

**Review workflow:**
- Evaluator opens a call recording → scores each criterion inline → adds timestamped comments anchored to specific call moments.
- The completed scorecard is finalized (locked) and triggers a notification to the agent.
- Agent must acknowledge receipt; acknowledgment is audited.

**Coaching sessions:**
- Supervisor can attach a coaching note to any scorecard. Note is visible to the agent in their portal.
- Coaching notes are distinct from scorecard comments — they are actionable guidance, not evaluation observations.
- Dispute mechanism: agent can flag a scored item for supervisor review within a configurable window (default 7 days). Supervisor resolves; final score is immutable after resolution.

**Calibration:**
- Multiple evaluators score the same call independently using the same template.
- Platform computes inter-rater agreement (IRA) as coefficient of variation across evaluators.
- Calibration sessions have a moderator who can see all scores and reveal/hide them during the session.
- Calibration scores can optionally be excluded from agent KPIs or included as a separate calibration pool.

**Trend dashboards:**
- Per-agent scorecard average over configurable rolling windows (7d, 30d, 90d, YTD).
- Supervisor dashboard shows team average and distribution.
- Drill-down by criterion: which criteria are consistently low across the team?

**References:** Five9 QM documentation (help.five9.com), Five9 QM Admin Guide 2024.

### 1.2 Genesys Cloud CX — Performance Management / Evaluation

Genesys Cloud uses the term "Evaluation" for its post-call QA scorecard flow and "Coaching Appointment" for the structured feedback session.

**Evaluation forms:**
- Form builder with free-form sections, N/A options per criterion, and conditional visibility rules (e.g., compliance section only shown if call disposition = SALE).
- Scoring: 0–10 per question, or Yes/No, or custom scale. Weights assigned per question, not per section; Genesys sums weighted scores to 100-point scale.
- Critical questions: same auto-fail pattern as Five9 — one 0 on a critical question = form score of 0.

**Annotation / timestamps:**
- Evaluator can insert bookmarks at specific audio timestamps during playback; each bookmark carries a text comment and a tag (Positive / Needs Improvement / Training Opportunity).
- Bookmarks are stored as part of the evaluation, surfaced in the evaluation detail view.

**Agent self-evaluation:**
- Agents can be required to self-evaluate against the same form before seeing supervisor scores.
- Self-evaluation locked after supervisor submits; both scores shown side-by-side.
- Gap analysis: where do agent self-scores deviate most from supervisor scores?

**Coaching Appointments:**
- Formal coaching sessions are scheduled (date/time/duration), linked to 1..N evaluations.
- Coaching appointment has a "development plan" free-text field.
- Completion is tracked; overdue coaching appointments surface in supervisor dashboard.

**Calibration:**
- Genesys calls these "Calibrations." A calibration session attaches the same call to N evaluators, each submits independently. After deadline, moderator reveals all scores.
- Reports show inter-rater deviation and calibration drift over time.

**References:** Genesys Cloud CX Help Center (help.mypurecloud.com): Quality Management, Evaluations, Coaching Appointments, Calibrations (2024-2025 docs).

### 1.3 NICE CXone — Quality Management

NICE CXone (formerly inContact) ships Quality Management as a core module with a separate licensing tier.

**Scorecard model:**
- Hierarchical: Form → Section → Question.
- Question types: Yes/No binary, Numeric scale (1–N), Free-text (no score), NA-eligible.
- Weighted scoring: question weight within section, section weight within form; all normalized to 0–100.
- Auto-fail: any question can be a "Critical" question where a zero zeroes the form.

**Screen recording integration:**
- NICE natively records agent screen alongside audio. Evaluators see split-view: audio waveform + screen capture. Screen captures are frame-timestamped.
- Vici2 Phase 1 does not have screen recording; this is noted as a Phase 3+ feature.

**Annotation tool:**
- Called "Markers" in NICE. Evaluators place markers at any timestamp; markers carry: category (customizable), comment, sentiment (positive/negative/coaching).
- Markers exported in QM reports; visible in agent self-view.

**Live coaching (SpeechPad):**
- NICE offers live supervisor-to-agent text messaging during an active call without the customer hearing.
- This is distinct from S02's whisper mode (audio). Vici2 plans text-channel live coaching as Phase 3 (see §4 below).

**Trend and aggregation:**
- NICE QM reports: agent scorecard trend (sparkline per agent, 13-week), team distribution histogram, criterion-level heatmap.
- All reports are filterable by evaluator, form, campaign, date range, supervisor group.

**References:** NICE CXone Help (niceincontact.com), NICE CXone QM Administrator Guide 2024-2025.

---

## 2. Scorecard Models: Weighted-Criteria vs Binary Checklist vs Hybrid

### 2.1 Weighted-Criteria (Continuous)

Each criterion carries a numeric weight (percentage of total score) and a max_score (e.g., 0–5). Agent's actual score for that criterion is 0..max_score. Contribution to total:

```
contribution_i = (score_i / max_score_i) * weight_i
total_score    = SUM(contribution_i)               // 0..100
```

**Advantages:**
- Gradations — a mediocre performance is not the same as a failing one.
- Granular trend analysis per criterion.
- Aligns with Five9 / Genesys / NICE all moving to weighted models.

**Disadvantages:**
- More cognitive load for evaluator (selecting 1–5 vs yes/no).
- Weight misconfiguration can distort outcomes if not validated (weights must sum to 100%).

### 2.2 Binary Checklist (Yes/No)

Each criterion is pass/fail. Score = COUNT(pass) / COUNT(criteria), optionally weighted.

**Advantages:**
- Fast to complete; less evaluator subjectivity.
- Good for compliance checklists (disclosed caller ID: yes/no).

**Disadvantages:**
- No gradation; masks quality variation.
- Binary auto-fail and weighted binary collapse to similar behaviors.

### 2.3 Hybrid Model (Recommended for Vici2)

A single template supports mixed question types:
- `type: numeric` — 0..max_score with weight.
- `type: binary` — yes(=max_score)/no(=0)/na with weight.
- `type: auto_fail` — binary; zero on this zeroes the entire form regardless of other scores.
- `type: text_only` — free-text observation with no score contribution (weight=0 or omitted).

This matches the Genesys model and is the most common industry approach. Weights are validated server-side: sum of weights for scoring criteria (excluding text_only) must equal 100.0 (±0.01 floating-point tolerance).

**Criteria JSON schema (stored in scorecard_templates.criteria):**

```json
[
  {
    "id": "uuid-v4",
    "label": "Proper greeting delivered",
    "type": "binary",
    "weight": 10,
    "max_score": 1,
    "section": "Opening",
    "auto_fail": false,
    "na_eligible": false
  },
  {
    "id": "uuid-v4",
    "label": "Agent offered refund options",
    "type": "numeric",
    "weight": 20,
    "max_score": 5,
    "section": "Resolution",
    "auto_fail": false,
    "na_eligible": true
  },
  {
    "id": "uuid-v4",
    "label": "PCI compliance — no verbalization of full card number",
    "type": "auto_fail",
    "weight": 0,
    "max_score": 1,
    "section": "Compliance",
    "auto_fail": true,
    "na_eligible": false
  },
  {
    "id": "uuid-v4",
    "label": "Additional coaching notes from evaluator",
    "type": "text_only",
    "weight": 0,
    "max_score": 0,
    "section": "Notes",
    "auto_fail": false,
    "na_eligible": false
  }
]
```

**N/A handling:** When `na_eligible=true` and evaluator marks N/A, that criterion is excluded from the total computation; remaining weights are proportionally re-normalized for that evaluation.

---

## 3. Call Annotations: Timestamp + Text + Tag

### 3.1 What annotations are

Call annotations are evaluator-placed markers at specific audio timestamps during playback. They are:
- **Separate** from the scorecard score — they are observational evidence, not scores.
- **Linked** to a call_uuid and (optionally) a scorecard; they can exist without a scorecard (pure QA review pass).
- **Typed by tag:** `positive`, `needs_improvement`, `training_opportunity`, `compliance_flag`, `praise`.

### 3.2 UX model (following Genesys / NICE)

1. Evaluator opens review-call page (extends R03 detail page).
2. Audio player is playing; evaluator clicks the "+" button (or keyboard shortcut `A`) to drop an annotation at the current playback timestamp.
3. A small popover appears: text input + tag selector (dropdown or icon set). Evaluator types observation and submits.
4. Annotation appears as a colored pin on the waveform timeline, color-coded by tag.
5. Agent views the same waveform with pins in read-only mode.
6. Clicking a pin seeks the player to that timestamp — the primary interaction loop.

### 3.3 Technical requirements

- `timestamp_ms` stored as integer milliseconds from call start; synced with R03 audio playback current time.
- Annotations are mutable by the creating supervisor until scorecard is finalized.
- After finalization, annotations are locked (no edit/delete except by admin).
- Maximum 200 annotations per call (soft limit; enforced at API layer).

### 3.4 Integration with R03 wavesurfer.js

R03 already specifies wavesurfer.js for waveform rendering. The WaveSurfer Markers plugin (or custom region layer) supports rendering clickable pins at arbitrary positions. S05 extends R03's `RecordingPlayer.tsx` component (or creates a supervised subclass) that accepts an `annotations` prop and renders them.

---

## 4. Live Coaching vs Post-Call Review

### 4.1 Live coaching (Vici2 Phase 3 — deferred)

Live coaching means sending real-time text guidance to an agent while they are on a call, visible on their screen but inaudible to the customer. Examples:
- NICE SpeechPad: supervisor types in a panel; agent sees text appear in an overlay.
- Genesys Agent Assist: AI-generated next-best-action displayed to agent in real time.

**Why deferred for S05 Phase 1:**
- Requires a real-time push channel from supervisor UI to the specific agent's browser (WebSocket subscribed to agent_id).
- Couples tightly with S02 (eavesdrop/whisper mode) and A03 (WS) — those modules are themselves not yet implemented.
- Phase 3+ priority once the call-control plane (S02, T01 ESL, A03 WS) is stable.
- S02's whisper mode (supervisor audio heard only by agent) provides a lower-tech live coaching path that is already scoped.

**Phase 3 placeholder:** a `coaching_messages` table stub will be noted in the schema but not implemented.

### 4.2 Post-call review (Vici2 S05 Phase 1 — in scope)

Post-call review is the primary coaching workflow:
1. Supervisor searches completed calls (via S04 / R03 recording browser).
2. Opens call detail page with audio player.
3. Places annotations on the waveform.
4. Fills out a scorecard form.
5. Submits feedback message to agent.
6. Agent receives notification (N01), opens their feedback inbox, reviews scorecard + annotations + feedback note, and acknowledges.

All five steps are in S05 Phase 1 scope.

---

## 5. Agent Self-Review (Acknowledge Feedback)

### 5.1 Industry standard

All three platforms (Five9, Genesys, NICE) require agent acknowledgment of coaching feedback. This serves:
- **Legal / HR:** proof that the agent was informed of performance issue.
- **Compliance:** some regulated industries require documented coaching acknowledgment.
- **Engagement:** agents who see their own feedback are more likely to improve.

### 5.2 Vici2 implementation

The `agent_feedback` table carries an `acknowledged_at DATETIME NULL` field. It is NULL until the agent clicks "Acknowledge" in their feedback inbox. The API PATCH endpoint sets `acknowledged_at = NOW()`.

**Rules:**
- Only the target agent can acknowledge their own feedback (RBAC scope=own or scope=self for the agent role).
- Acknowledged_at is immutable once set (cannot un-acknowledge).
- Supervisor can see acknowledgment status; unacknowledged items appear with a badge.
- Reporting: unacknowledged feedback age (days since created_at) surfaces in M03 agent productivity reports.

### 5.3 Agent self-evaluation (Phase 2)

Genesys supports mandatory agent self-evaluation before seeing supervisor scores. Vici2 defers agent self-evaluation to Phase 2; the schema comment-stub is noted. Phase 2 adds: `call_scorecards.agent_scores JSON NULL` column and `agent_submitted_at DATETIME NULL`.

---

## 6. Performance Trend Tracking (Per-Agent Scorecard Avg Over Time)

### 6.1 Data shape

Every `call_scorecard` row carries:
- `agent_id` — the agent being evaluated.
- `total_score DECIMAL(5,2)` — computed 0–100.
- `template_id` — which template (critical: compare scores only within the same template).
- `created_at` — when finalized.
- `is_calibration TINYINT(1)` — calibration rows excluded from agent KPI trends by default.

### 6.2 Trend query

```sql
SELECT
  agent_id,
  template_id,
  DATE(created_at)                              AS scored_date,
  AVG(total_score)                              AS avg_score,
  COUNT(*)                                      AS eval_count
FROM call_scorecards
WHERE tenant_id = :tid
  AND agent_id  = :agent_id
  AND template_id = :template_id
  AND is_calibration = 0
  AND created_at BETWEEN :from AND :to
GROUP BY agent_id, template_id, DATE(created_at)
ORDER BY scored_date ASC;
```

### 6.3 Integration with M03

M03 (agent productivity reports) currently aggregates talk_seconds, calls_per_hour, disposition counts. S05 extends M03 by adding a `coaching_stats` sub-object:

```json
{
  "agent_id": 123,
  "period": "2026-04-01/2026-04-30",
  "coaching_stats": {
    "evaluations_received": 14,
    "avg_scorecard_score": 81.4,
    "feedback_items": 8,
    "unacknowledged_feedback": 2,
    "trend_7d_delta": +3.2
  }
}
```

### 6.4 Criteria-level trend

Beyond total score, supervisors need per-criterion averages to identify coaching targets. The criterion scores are stored in `call_scorecards.scores JSON`, so the API computes averages in application code (MySQL JSON_EXTRACT is available but aggregation over JSON arrays is done in Node.js for Phase 1; Phase 2 can extract into a `scorecard_criterion_scores` wide table for efficient GROUP BY).

---

## 7. Calibration Sessions (Multiple Supervisors Score Same Call)

### 7.1 What calibration is

Calibration is a QA governance process where multiple evaluators (supervisors or QA leads) independently score the same call using the same template. The purpose:
- Detect evaluator bias / inconsistency.
- Establish ground truth for training purposes.
- Satisfy ISO 9001 / COPC quality management requirements (common in BPO environments).

### 7.2 Calibration workflow

1. A "calibration moderator" (admin or designated supervisor) creates a calibration session:
   - Selects 1..N calls.
   - Assigns 2..N evaluators.
   - Sets a deadline.
2. Assigned evaluators score each call independently — they cannot see each other's scores until the moderator reveals.
3. After deadline (or moderator "closes" session early), moderator views all scores side-by-side.
4. Moderator may optionally designate one evaluator's score as the "official" score for the call.
5. Calibration scores are flagged `is_calibration=1` and excluded from agent KPI trends by default (configurable).

### 7.3 Inter-rater agreement

Computed as the coefficient of variation (CV = σ/μ) across evaluator total scores for a given call:
- CV < 10%: good agreement (green).
- 10–20%: moderate variation (amber).
- CV > 20%: poor agreement — calibration training needed (red).

Phase 1 computes CV in application code. Phase 2 may surface this in a dedicated calibration analytics dashboard.

### 7.4 Phase gating

**Phase 1 (S05 delivery):** `scorecard_calibration_sessions` and `scorecard_calibration_assignments` tables are scaffolded in the migration but all calibration API endpoints return `501 Not Implemented`. The `is_calibration` flag on `call_scorecards` is usable immediately.

**Phase 2:** Full calibration workflow — session creation, assignment, blind scoring, reveal, inter-rater report.

---

## 8. Open Questions

| # | Question | Current stance | Deferred to |
|---|---|---|---|
| OQ-1 | Should agents be able to dispute individual scorecard criteria (like Five9)? | Phase 2. Phase 1: agent can only acknowledge/comment on feedback. | Phase 2 |
| OQ-2 | Agent self-evaluation (submit own scores before seeing supervisor scores)? | Phase 2. Stub columns added to schema. | Phase 2 |
| OQ-3 | Should annotations be exportable as a PDF report alongside the scorecard? | Phase 2 (PDF generation not in Phase 1 stack). | Phase 2 |
| OQ-4 | Live coaching (real-time text to agent during a call)? | Phase 3. Requires S02 / A03 to be stable. | Phase 3 |
| OQ-5 | AI-assisted scoring (auto-score based on N07 transcript)? | Phase 4. N07 transcription itself is Phase 4. Requires transcript + LLM call. | Phase 4 |
| OQ-6 | Multi-template calibration (different evaluators use different templates for same call)? | Explicitly rejected — always same template per calibration session. | N/A |
| OQ-7 | How are scorecard_templates versioned when criteria change mid-campaign? | Template versions: editing an active template creates a new version with `parent_template_id`. Old scorecards point to old template version. | Implement in Phase 1 schema (version column) |
| OQ-8 | Can an agent view recordings of their own calls (not just scorecards)? | RBAC `recording:list scope=own` already granted to agent role. Agent can play own recordings from their portal. Annotations are agent-visible after scorecard finalization. | In scope Phase 1 |
| OQ-9 | How is GDPR right-to-erasure handled for scorecard data? | Scorecard data references `agent_id` (a user_id FK). If user is deleted, `agent_id` SET NULL; `agent_feedback.body` scrubbed by a legal-hold worker (Phase 4). | Phase 4 |
| OQ-10 | Should supervisors be able to see scores assigned by other supervisors? | Tenant-wide: yes for admin. Group-scoped: supervisor sees scorecards they created + scorecards for agents in their group. | Phase 1 RBAC matrix |
| OQ-11 | What is the N07 (transcription) integration path? | S05 annotation panel will show transcript paragraph markers when a transcript exists. Transcript display is read-only; linking annotations to transcript segments is Phase 4. | Phase 4 |
| OQ-12 | Maximum number of scorecard templates per tenant? | Soft cap: 50 active templates per tenant (configurable via tenant.settings JSON). Enforced at API. | Phase 1 |

---

## 9. Summary of Key Industry Decisions

| Decision | Adopted Pattern | Rationale |
|---|---|---|
| Scorecard model | Hybrid (numeric + binary + auto_fail + text_only) | Matches Genesys/NICE; handles compliance auto-fail |
| Weight validation | Server-side: scoring criteria weights sum to 100±0.01 | Prevents silent misconfigured templates |
| Annotation sync | wavesurfer.js markers plugin; click → seek | R03 already uses wavesurfer.js; natural extension |
| Agent acknowledgment | `acknowledged_at` field; immutable once set; audited | HR/legal requirement; all three platforms require it |
| Calibration | Scaffolded Phase 1; full implementation Phase 2 | Phase 1 is post-call review + scorecards |
| Trend analytics | Per-template, per-agent, date-range avg; integrated into M03 | Consistent with M03 agent productivity reports |
| Live coaching | Phase 3 (requires S02/A03/T01 stability) | Architectural dependency; defer cleanly |
| Auto-scoring (N07) | Phase 4 (requires transcripts + LLM) | Correct sequencing after N07 ships |

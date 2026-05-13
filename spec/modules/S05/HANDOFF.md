# S05 — Supervisor Coaching Tools — HANDOFF

## Summary

Full implementation of the S05 Supervisor Coaching Tools module: scorecard templates with versioning, call review page with timestamped annotations, scorecard fill/finalize flow, agent feedback inbox, trend reporting, RBAC verbs, and calibration scaffold.

---

## Migration

**File:** `api/prisma/migrations/20260513270000_s05_coaching/migration.sql`

Creates 6 new tables:
- `scorecard_templates` — versioned scoring rubrics with JSON criteria column
- `call_scorecards` — per-call scorecard instances with JSON scores, status (draft/finalized)
- `call_annotations` — timestamped inline annotations linked to a call UUID
- `agent_feedback` — free-text coaching notes from supervisor to agent
- `scorecard_calibration_sessions` — scaffold only (endpoints return 501)
- `scorecard_calibration_assignments` — scaffold only (endpoints return 501)

---

## Prisma Schema Changes

**File:** `api/prisma/schema.prisma`

- Added S05 relation fields on `User` model: `scorecardTemplatesCreated`, `scorecardsSupervisor`, `scorecardsAgent`, `annotationsSupervisor`, `feedbackReceived`, `feedbackGiven`
- Added S05 relation fields on `Tenant` model: `scorecardTemplates`, `callScorecards`, `callAnnotations`, `agentFeedback`
- Added new models: `ScorecardTemplate`, `CallScorecard`, `CallAnnotation`, `AgentFeedback`
- Added new enums: `ScorecardStatus` (draft, finalized), `AnnotationTag` (positive, needs_improvement, training_opportunity, compliance_flag, praise)

---

## RBAC New Verbs

**File:** `shared/types/src/rbac.ts`

| Verb | super_admin | admin | supervisor | agent | viewer |
|------|-------------|-------|-----------|-------|--------|
| scorecard:read | tenant | tenant | group | own | tenant |
| scorecard:create | tenant | tenant | group | — | — |
| scorecard:finalize | tenant (sensitive) | tenant (sensitive) | group | — | — |
| scorecard:template_edit | tenant (sensitive) | tenant (sensitive) | — | — | — |
| feedback:read | tenant | tenant | group | own | tenant |
| feedback:create | tenant | tenant | group | — | — |

---

## Audit Actions Added

**File:** `api/src/auth/audit.ts`

New action strings added:
- `coaching.template.created`
- `coaching.template.updated`
- `coaching.template.versioned`
- `coaching.template.deactivated`
- `coaching.scorecard.draft_saved`
- `coaching.scorecard.finalized`
- `coaching.scorecard.unlocked`
- `coaching.annotation.created`
- `coaching.annotation.updated`
- `coaching.annotation.deleted`
- `coaching.feedback.created`
- `coaching.feedback.acknowledged`

---

## Files Changed / Created

### API — Services
| File | Purpose |
|------|---------|
| `api/src/services/coaching/types.ts` | Shared TS types: ScorecardCriterion, ScoreEntry, CriterionType |
| `api/src/services/coaching/scorecard-service.ts` | computeTotal(), validateScoresComplete(), ScorecardService |
| `api/src/services/coaching/template-service.ts` | validateCriteria(), TemplateService with versioning |
| `api/src/services/coaching/annotation-service.ts` | AnnotationService with lock enforcement, 200-cap |
| `api/src/services/coaching/feedback-service.ts` | FeedbackService with acknowledge idempotency |
| `api/src/services/coaching/coaching-report-service.ts` | CoachingReportService: M03 stats, agent trend, team summary |

### API — Routes (Supervisor)
| File | Routes |
|------|--------|
| `api/src/routes/sup/coaching/index.ts` | Route registration |
| `api/src/routes/sup/coaching/handlers/templates.ts` | GET /api/sup/coaching/templates |
| `api/src/routes/sup/coaching/handlers/calls.ts` | GET /api/sup/coaching/calls/:uuid |
| `api/src/routes/sup/coaching/handlers/annotations.ts` | CRUD /api/sup/coaching/calls/:uuid/annotations |
| `api/src/routes/sup/coaching/handlers/scorecards.ts` | GET/POST/PATCH scorecard; POST finalize; GET agent scorecards |
| `api/src/routes/sup/coaching/handlers/feedback.ts` | POST feedback; GET agent feedback |
| `api/src/routes/sup/coaching/handlers/reports.ts` | GET agent-trend; GET team-summary |

### API — Routes (Admin)
| File | Routes |
|------|--------|
| `api/src/routes/admin/coaching/index.ts` | Route registration |
| `api/src/routes/admin/coaching/handlers/templates.ts` | Full CRUD for scorecard templates |
| `api/src/routes/admin/coaching/handlers/unlock.ts` | POST unlock finalized scorecard |
| `api/src/routes/admin/coaching/handlers/calibrations.ts` | All calibration endpoints return 501 |

### API — Routes (Agent)
| File | Routes |
|------|--------|
| `api/src/routes/agent/feedback/index.ts` | Route registration |
| `api/src/routes/agent/feedback/handlers/list.ts` | GET /api/agent/feedback |
| `api/src/routes/agent/feedback/handlers/detail.ts` | GET /api/agent/feedback/:id |
| `api/src/routes/agent/feedback/handlers/acknowledge.ts` | PATCH /api/agent/feedback/:id/acknowledge |
| `api/src/routes/agent/feedback/handlers/scorecards.ts` | GET /api/agent/scorecards, GET /api/agent/scorecards/:id |

### API — Modified Files
| File | Change |
|------|--------|
| `api/prisma/schema.prisma` | Added S05 models, enums, relations |
| `api/src/auth/audit.ts` | Added coaching audit action strings |
| `api/src/routes/admin/index.ts` | Registered admin coaching routes |
| `api/src/routes/supervisor/index.ts` | Registered supervisor coaching routes |
| `api/src/server.ts` | Registered agent feedback routes |

### Web — Components
| File | Purpose |
|------|---------|
| `web/src/components/coaching/types.ts` | Shared FE types + TAG_COLORS/TAG_LABELS |
| `web/src/components/coaching/ScoreDisplay.tsx` | Color-coded score badge |
| `web/src/components/coaching/CriterionInput.tsx` | Per-criterion input by CriterionType |
| `web/src/components/coaching/ScorecardForm.tsx` | Template-driven form with live total |
| `web/src/components/coaching/AnnotationPanel.tsx` | Scrollable annotations, seek-on-click |
| `web/src/components/coaching/AnnotationPopover.tsx` | Add/edit annotation modal |
| `web/src/components/coaching/FeedbackCard.tsx` | Agent feedback card + acknowledge |
| `web/src/components/coaching/FeedbackComposer.tsx` | Supervisor feedback composer |
| `web/src/components/coaching/TeamSummaryTable.tsx` | Per-agent avg score table |

### Web — Pages
| File | Route |
|------|-------|
| `web/src/app/(sup)/coaching/page.tsx` | /sup/coaching — hub with quick actions |
| `web/src/app/(sup)/coaching/calls/[callUuid]/review/page.tsx` | RSC shell for call review |
| `web/src/app/(sup)/coaching/calls/[callUuid]/review/ReviewShell.tsx` | Three-panel interactive review UI |
| `web/src/app/(agent)/feedback/page.tsx` | Agent feedback inbox (tabs: notes / scorecards) |
| `web/src/app/(agent)/feedback/scorecards/[id]/page.tsx` | Read-only scorecard detail |
| `web/src/app/(admin)/coaching/templates/page.tsx` | Admin template management table |

### Tests
| File | Tests |
|------|-------|
| `api/test/coaching/scorecard-service.test.ts` | 14 — computeTotal, validateScoresComplete |
| `api/test/coaching/template-service.test.ts` | 13 — validateCriteria |
| `api/test/coaching/annotation-service.test.ts` | 8 — lock enforcement, 200-cap |
| `api/test/coaching/feedback-service.test.ts` | 6 — acknowledge idempotency |

**Test results:** 41/41 passed

---

## Score Computation Algorithm

`computeTotal(criteria, scores)` in `scorecard-service.ts`:
1. Any `auto_fail` criterion with score=0 → returns 0.0 immediately
2. NA responses excluded from weight pool; remaining weights re-normalized to 100%
3. Each score mapped to proportion: `(score / maxScore) * weight`
4. Sum of proportions → final score (0–100, 2dp)
5. Returns 0 if no scoreable criteria remain

---

## Key Design Decisions

- **Versioning**: When a template with linked finalized scorecards is edited, a new template row is created with `parentId` pointing to the old one, and the old is archived (`isActive=false`). No in-place mutation of templates referenced by finalized scorecards.
- **Annotation lock**: Mutations to annotations are rejected if the linked scorecard is `finalized`.
- **Calibration**: Tables exist; all endpoints return `501 Not Implemented` with `{ error: 'not_implemented', message: '...' }`.
- **Notifications**: Inserted into `notifications` table on scorecard finalization and on new feedback creation.
- **Local AnnotationTagValue type**: Used instead of importing from `@prisma/client` to avoid Prisma client generation dependency in the service layer.

---

## Follow-ups / Not In Scope

- Calibration session flow (endpoints scaffold only — returns 501)
- Per-agent coaching history page: `(sup)/agents/[agentId]/coaching/`
- Admin template editor/detail page: `(admin)/coaching/templates/[id]/`
- Annotation pins rendered on wavesurfer.js waveform (AnnotationPanel wires seek; waveform pin rendering is a R03 concern)
- Bulk acknowledge for feedback inbox
- Export scorecards to PDF/CSV

// S05 — Supervisor coaching routes registration.
//
// Route map:
//   GET  /api/sup/coaching/templates                        scorecard:read
//   GET  /api/sup/coaching/calls/:uuid                      scorecard:read
//   GET  /api/sup/coaching/calls/:uuid/annotations          scorecard:read
//   POST /api/sup/coaching/calls/:uuid/annotations          scorecard:create
//   PATCH /api/sup/coaching/calls/:uuid/annotations/:id     scorecard:create
//   DELETE /api/sup/coaching/calls/:uuid/annotations/:id    scorecard:create
//   GET  /api/sup/coaching/calls/:uuid/scorecard            scorecard:read
//   POST /api/sup/coaching/calls/:uuid/scorecard            scorecard:create
//   PATCH /api/sup/coaching/calls/:uuid/scorecard           scorecard:create
//   POST /api/sup/coaching/calls/:uuid/scorecard/finalize   scorecard:finalize
//   POST /api/sup/coaching/calls/:uuid/feedback             feedback:create
//   GET  /api/sup/coaching/agents/:agentId/scorecards       scorecard:read
//   GET  /api/sup/coaching/agents/:agentId/feedback         feedback:read
//   GET  /api/sup/coaching/reports/agent-trend              scorecard:read
//   GET  /api/sup/coaching/reports/team-summary             scorecard:read

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = any;

import { handleListTemplates } from './handlers/templates.js';
import { handleGetCallForReview } from './handlers/calls.js';
import {
  handleListAnnotations,
  handleCreateAnnotation,
  handleUpdateAnnotation,
  handleDeleteAnnotation,
} from './handlers/annotations.js';
import {
  handleGetScorecard,
  handleCreateScorecard,
  handleUpdateScorecard,
  handleFinalizeScorecard,
  handleGetAgentScorecards,
} from './handlers/scorecards.js';
import { handleCreateFeedbackForCall, handleGetAgentFeedback } from './handlers/feedback.js';
import { handleAgentTrend, handleTeamSummary } from './handlers/reports.js';

export async function registerSupCoachingRoutes(app: App): Promise<void> {
  // Templates
  app.get('/api/sup/coaching/templates', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleListTemplates);

  // Call metadata
  app.get('/api/sup/coaching/calls/:uuid', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleGetCallForReview);

  // Annotations
  app.get('/api/sup/coaching/calls/:uuid/annotations', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleListAnnotations);

  app.post('/api/sup/coaching/calls/:uuid/annotations', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:create')],
  }, handleCreateAnnotation);

  app.patch('/api/sup/coaching/calls/:uuid/annotations/:id', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:create')],
  }, handleUpdateAnnotation);

  app.delete('/api/sup/coaching/calls/:uuid/annotations/:id', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:create')],
  }, handleDeleteAnnotation);

  // Scorecards
  app.get('/api/sup/coaching/calls/:uuid/scorecard', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleGetScorecard);

  app.post('/api/sup/coaching/calls/:uuid/scorecard', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:create')],
  }, handleCreateScorecard);

  app.patch('/api/sup/coaching/calls/:uuid/scorecard', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:create')],
  }, handleUpdateScorecard);

  app.post('/api/sup/coaching/calls/:uuid/scorecard/finalize', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:finalize')],
  }, handleFinalizeScorecard);

  // Feedback
  app.post('/api/sup/coaching/calls/:uuid/feedback', {
    preHandler: [app.requireAuth, app.requirePermission('feedback:create')],
  }, handleCreateFeedbackForCall);

  // Per-agent views
  app.get('/api/sup/coaching/agents/:agentId/scorecards', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleGetAgentScorecards);

  app.get('/api/sup/coaching/agents/:agentId/feedback', {
    preHandler: [app.requireAuth, app.requirePermission('feedback:read')],
  }, handleGetAgentFeedback);

  // Reports
  app.get('/api/sup/coaching/reports/agent-trend', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleAgentTrend);

  app.get('/api/sup/coaching/reports/team-summary', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleTeamSummary);
}

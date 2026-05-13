// S05 — Agent feedback + scorecard inbox routes registration.
//
// Route map:
//   GET   /api/agent/feedback                     feedback:read
//   GET   /api/agent/feedback/:id                 feedback:read
//   PATCH /api/agent/feedback/:id/acknowledge     feedback:read
//   GET   /api/agent/scorecards                   scorecard:read
//   GET   /api/agent/scorecards/:id               scorecard:read

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = any;

import { handleAgentListFeedback } from './handlers/list.js';
import { handleAgentGetFeedback } from './handlers/detail.js';
import { handleAgentAcknowledgeFeedback } from './handlers/acknowledge.js';
import { handleAgentListScorecards, handleAgentGetScorecard } from './handlers/scorecards.js';

export async function registerAgentFeedbackRoutes(app: App): Promise<void> {
  // Feedback inbox
  app.get('/api/agent/feedback', {
    preHandler: [app.requireAuth, app.requirePermission('feedback:read')],
  }, handleAgentListFeedback);

  app.get('/api/agent/feedback/:id', {
    preHandler: [app.requireAuth, app.requirePermission('feedback:read')],
  }, handleAgentGetFeedback);

  app.patch('/api/agent/feedback/:id/acknowledge', {
    preHandler: [app.requireAuth, app.requirePermission('feedback:read')],
  }, handleAgentAcknowledgeFeedback);

  // Agent's own scorecards
  app.get('/api/agent/scorecards', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleAgentListScorecards);

  app.get('/api/agent/scorecards/:id', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:read')],
  }, handleAgentGetScorecard);
}

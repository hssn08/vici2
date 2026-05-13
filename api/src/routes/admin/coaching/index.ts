// S05 — Admin coaching routes registration.
//
// Route map:
//   GET    /api/admin/coaching/templates          scorecard:template_edit
//   POST   /api/admin/coaching/templates          scorecard:template_edit
//   GET    /api/admin/coaching/templates/:id      scorecard:template_edit
//   PATCH  /api/admin/coaching/templates/:id      scorecard:template_edit
//   DELETE /api/admin/coaching/templates/:id      scorecard:template_edit
//   POST   /api/admin/coaching/scorecards/:id/unlock  scorecard:template_edit
//   POST   /api/admin/coaching/calibrations       → 501
//   GET    /api/admin/coaching/calibrations       → 501
//   GET    /api/admin/coaching/calibrations/:id   → 501
//   POST   /api/admin/coaching/calibrations/:id/close → 501

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = any;

import {
  handleAdminListTemplates,
  handleAdminGetTemplate,
  handleAdminCreateTemplate,
  handleAdminUpdateTemplate,
  handleAdminDeactivateTemplate,
} from './handlers/templates.js';
import { handleAdminUnlockScorecard } from './handlers/unlock.js';
import { handleCalibrationStub } from './handlers/calibrations.js';

export async function registerAdminCoachingRoutes(app: App): Promise<void> {
  // Templates
  app.get('/api/admin/coaching/templates', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:template_edit')],
  }, handleAdminListTemplates);

  app.post('/api/admin/coaching/templates', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:template_edit')],
  }, handleAdminCreateTemplate);

  app.get('/api/admin/coaching/templates/:id', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:template_edit')],
  }, handleAdminGetTemplate);

  app.patch('/api/admin/coaching/templates/:id', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:template_edit')],
  }, handleAdminUpdateTemplate);

  app.delete('/api/admin/coaching/templates/:id', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:template_edit')],
  }, handleAdminDeactivateTemplate);

  // Emergency unlock
  app.post('/api/admin/coaching/scorecards/:id/unlock', {
    preHandler: [app.requireAuth, app.requirePermission('scorecard:template_edit')],
  }, handleAdminUnlockScorecard);

  // Calibration stubs (Phase 2)
  app.post('/api/admin/coaching/calibrations', {
    preHandler: [app.requireAuth],
  }, handleCalibrationStub);

  app.get('/api/admin/coaching/calibrations', {
    preHandler: [app.requireAuth],
  }, handleCalibrationStub);

  app.get('/api/admin/coaching/calibrations/:id', {
    preHandler: [app.requireAuth],
  }, handleCalibrationStub);

  app.post('/api/admin/coaching/calibrations/:id/close', {
    preHandler: [app.requireAuth],
  }, handleCalibrationStub);
}

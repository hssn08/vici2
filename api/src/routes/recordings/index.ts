/**
 * api/src/routes/recordings/index.ts
 *
 * Aggregate registration for /api/recordings/* routes.
 * R02 PLAN §14.
 */

import { registerRecordingMetadataRoute } from './metadata.js';
import { registerRecordingUrlRoute } from './url.js';
import { registerLegalHoldRoutes } from './legal-hold.js';
import { registerIntegrityRoute } from './integrity.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerRecordingRoutes(app: any): Promise<void> {
  await registerRecordingMetadataRoute(app);
  await registerRecordingUrlRoute(app);
  await registerLegalHoldRoutes(app);
  await registerIntegrityRoute(app);
}

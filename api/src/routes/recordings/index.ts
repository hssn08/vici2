/**
 * api/src/routes/recordings/index.ts
 *
 * Aggregate registration for /api/recordings/* routes.
 * R02 PLAN §14. R03 PLAN §4.
 */

import { registerRecordingMetadataRoute } from './metadata.js';
import { registerRecordingUrlRoute } from './url.js';
import { registerLegalHoldRoutes } from './legal-hold.js';
import { registerIntegrityRoute } from './integrity.js';
import { registerTranscriptRoutes } from './transcript.js';
import { registerRecordingListRoute } from './list.js';     // R03
import { registerRecordingDetailRoute } from './detail.js'; // R03

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerRecordingRoutes(app: any): Promise<void> {
  // R03: list + rich detail (registered BEFORE :id routes to avoid conflicts)
  await registerRecordingListRoute(app);
  await registerRecordingDetailRoute(app);
  // R02: raw metadata, pre-signed URL, legal hold, integrity, transcript
  await registerRecordingMetadataRoute(app);
  await registerRecordingUrlRoute(app);
  await registerLegalHoldRoutes(app);
  await registerIntegrityRoute(app);
  await registerTranscriptRoutes(app); // N07 — transcript GET + retry POST
}

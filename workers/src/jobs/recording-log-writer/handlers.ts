/**
 * workers/src/jobs/recording-log-writer/handlers.ts
 *
 * Low-level I/O helpers for the recording-log-writer job.
 * Separated to allow easy test-double injection.
 */

import { stat } from 'node:fs/promises';

/**
 * statFile returns the byte size of the recording file at the given path.
 * Throws if the file does not exist or is not readable (caller handles).
 */
export async function statFile(filePath: string): Promise<number> {
  const info = await stat(filePath);
  return info.size;
}

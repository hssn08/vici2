/**
 * workers/src/lib/shutdown.ts
 *
 * ShutdownManager — registers Closeable resources and drains them in reverse
 * registration order on SIGTERM/SIGINT. Forces exit after per-resource timeout.
 */

import type { Logger } from 'pino';

export interface Closeable {
  name: string;
  close: () => Promise<void>;
  timeoutMs?: number;
}

export class ShutdownManager {
  private shuttingDown = false;
  private readonly closeables: Closeable[] = [];

  /** Register a closeable resource (shutdown in reverse order). */
  register(closeable: Closeable): void {
    this.closeables.push(closeable);
  }

  /** Bind a process signal to trigger shutdown. */
  listenFor(signal: string, logger: Logger): void {
    process.on(signal, () => void this.shutdown(signal, logger));
  }

  async shutdown(signal: string, logger: Logger): Promise<never> {
    if (this.shuttingDown) return process.exit(0);
    this.shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown initiated');

    for (const closeable of [...this.closeables].reverse()) {
      const timeout = closeable.timeoutMs ?? 50_000;
      try {
        await Promise.race([
          closeable.close(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`timeout closing ${closeable.name}`)),
              timeout,
            ),
          ),
        ]);
        logger.info({ name: closeable.name }, 'closed successfully');
      } catch (err) {
        logger.warn({ name: closeable.name, err }, 'force-closed after timeout');
      }
    }

    logger.info('shutdown complete');
    process.exit(0);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

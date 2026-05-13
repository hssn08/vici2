/**
 * workers/src/jobs/freeswitch-event-router/index.ts
 *
 * FreeSWITCH event router — Redis Streams XREADGROUP consumer.
 *
 * Consumer group / stream (FROZEN per W01 PLAN §2.2):
 *   Streams:  events:vici2.call.* (multiple)
 *   Group:    freeswitch-event-router
 *   Consumer: freeswitch-event-router-{hostname}-{pid}
 *
 * T01 IMPLEMENT wires the actual event dispatch logic.
 * W01 IMPLEMENT provides the structural slot and DLQ integration point.
 *
 * @idempotency N/A — event routing is idempotent (FS events are processed
 *              at most once via XACK; XAUTOCLAIM handles stalled consumers).
 */

import { hostname } from 'node:os';
import type { Logger } from 'pino';

export const STREAM_CALL = 'events:vici2.call.*';
export const CONSUMER_GROUP = 'freeswitch-event-router';
export const CONSUMER_NAME = `freeswitch-event-router-${hostname()}-${process.pid}`;

export interface FreeSwitchEventRouterDeps {
  logger: Logger;
}

/**
 * FreeSwitchEventRouter — stub for T01 IMPLEMENT.
 *
 * T01 IMPLEMENT extends this class with:
 *   - XREADGROUP loop over events:vici2.call.* streams
 *   - XAUTOCLAIM for stalled entry recovery
 *   - Event dispatch to freeswitch-handler modules
 *   - DlqWriter on max retries
 */
export class FreeSwitchEventRouter {
  private running = false;

  constructor(private readonly deps: FreeSwitchEventRouterDeps) {}

  async start(): Promise<void> {
    this.running = true;
    this.deps.logger.info(
      { group: CONSUMER_GROUP, consumer: CONSUMER_NAME },
      'freeswitch-event-router: started (stub — T01 IMPLEMENT wires real logic)',
    );
    // T01 IMPLEMENT: replace this with XREADGROUP loop
  }

  stop(): void {
    this.running = false;
    this.deps.logger.info('freeswitch-event-router: stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }
}

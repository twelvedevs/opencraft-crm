import { createEventBus } from '@ortho/event-bus';
import type { EventBus } from '@ortho/event-bus';

/**
 * Creates the event bus instance for Integration Hub.
 * Does NOT call bus.start() — this service is publish-only (spec §2.1).
 */
export function createBus(): EventBus {
  return createEventBus();
}

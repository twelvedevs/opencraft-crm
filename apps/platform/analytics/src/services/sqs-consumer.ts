import type { Pool } from 'pg';
import pLimit from 'p-limit';
import { createEventBus } from '@ortho/event-bus';
import { routeEvent } from './event-router.js';

const EVENT_TYPES = [
  'lead.created',
  'lead.stage_changed',
  'lead.archived',
  'lead.converted',
  'message.delivered',
  'message.failed',
  'opt_out.received',
  'campaign.sent',
  'campaign.delivered',
  'email.opened',
  'email.clicked',
  'referral.converted',
  'ad_spend.synced',
] as const;

export function createSqsConsumer(pool: Pool): { start(): Promise<void>; stop(): Promise<void> } {
  const concurrency = Number(process.env['SQS_CONCURRENCY'] ?? '5');
  const limit = pLimit(concurrency);
  const bus = createEventBus();

  for (const eventType of EVENT_TYPES) {
    bus.subscribe(eventType, (event) => limit(() => routeEvent(event, pool)));
  }

  return {
    start: () => bus.start(),
    stop: () => bus.stop(),
  };
}

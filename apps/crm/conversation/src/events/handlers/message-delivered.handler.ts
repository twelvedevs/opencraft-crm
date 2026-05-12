import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { updateStatus } from '../../repositories/messages.repo.js';

const log = createLogger('crm-conversation');

export async function handleMessageDelivered(
  db: Knex,
  event: OrthoEvent,
): Promise<void> {
  const payload = event.payload as { message_id: string; delivered_at: string };
  const updated = await updateStatus(db, payload.message_id, {
    status: 'delivered',
    delivered_at: new Date(payload.delivered_at),
  });

  if (updated === 0) {
    log.debug('message not owned by conversation service, skipping');
  }
}

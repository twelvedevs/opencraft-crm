import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';
import { insertEvent } from '../repositories/events.js';
import { upsertMessageDaily } from '../repositories/rollups.js';

export async function handleOptOutReceived(event: OrthoEvent, pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const event_id = event.event_id ?? randomUUID();
    const occurred_at =
      typeof event.payload['occurred_at'] === 'string'
        ? new Date(event.payload['occurred_at'])
        : new Date();

    const location_id = String(event.payload['location_id'] ?? '');
    const date = occurred_at.toISOString().slice(0, 10);

    const { inserted } = await insertEvent(client, {
      event_id,
      event_type: event.event_type,
      source: 'messaging-service',
      entity_type: 'opt-out',
      entity_id: event.entity_id,
      dimensions: { location_id },
      properties: event.payload,
      occurred_at,
    });

    if (inserted) {
      await upsertMessageDaily(client, { date, location_id, opt_outs_delta: 1 });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

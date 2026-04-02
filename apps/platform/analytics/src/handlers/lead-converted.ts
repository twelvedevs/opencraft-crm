import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';
import { insertEvent } from '../repositories/events.js';
import { upsertConversionDaily } from '../repositories/rollups.js';

export async function handleLeadConverted(event: OrthoEvent, pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const event_id = event.event_id ?? randomUUID();
    const occurred_at =
      typeof event.payload['occurred_at'] === 'string'
        ? new Date(event.payload['occurred_at'])
        : new Date();

    const location_id = String(event.payload['location_id'] ?? '');
    const channel = String(event.payload['channel'] ?? 'unknown');
    const date = occurred_at.toISOString().slice(0, 10);

    const { inserted } = await insertEvent(client, {
      event_id,
      event_type: event.event_type,
      source: 'lead-service',
      entity_type: 'lead',
      entity_id: event.entity_id,
      dimensions: { location_id, channel },
      properties: event.payload,
      occurred_at,
    });

    if (inserted) {
      await upsertConversionDaily(client, { date, location_id, channel, count_delta: 1 });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

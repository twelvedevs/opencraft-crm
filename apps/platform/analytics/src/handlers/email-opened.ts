import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';
import { insertEvent } from '../repositories/events.js';
import { upsertCampaignDaily } from '../repositories/rollups.js';

export async function handleEmailOpened(event: OrthoEvent, pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const event_id = event.event_id ?? randomUUID();
    const occurred_at =
      typeof event.payload['occurred_at'] === 'string'
        ? new Date(event.payload['occurred_at'])
        : new Date();

    const campaign_id = String(event.payload['campaign_id'] ?? '');
    const location_id = String(event.payload['location_id'] ?? '');
    const date = occurred_at.toISOString().slice(0, 10);

    const { inserted } = await insertEvent(client, {
      event_id,
      event_type: event.event_type,
      source: 'campaign-service',
      entity_type: 'email',
      entity_id: event.entity_id,
      dimensions: { campaign_id, location_id },
      properties: event.payload,
      occurred_at,
    });

    if (inserted) {
      await upsertCampaignDaily(client, { date, campaign_id, location_id, opened_delta: 1 });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

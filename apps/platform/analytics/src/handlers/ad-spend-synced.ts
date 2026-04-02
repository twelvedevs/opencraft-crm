import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';
import { insertEvent } from '../repositories/events.js';
import { upsertAdSpendDaily } from '../repositories/rollups.js';

// Relaxed idempotency: upsertAdSpendDaily always runs regardless of whether
// insertEvent returned inserted=true or false. This allows Integration Hub to
// re-publish corrected ad spend figures (same event_id) and have them overwrite
// the previous values. See spec Section 4 and 6.1.
export async function handleAdSpendSynced(event: OrthoEvent, pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const event_id = event.event_id ?? randomUUID();
    const occurred_at =
      typeof event.payload['occurred_at'] === 'string'
        ? new Date(event.payload['occurred_at'])
        : new Date();

    const platform = String(event.payload['platform'] ?? '');
    const location_id = String(event.payload['location_id'] ?? '');
    const synced_date = String(
      event.payload['synced_date'] ?? occurred_at.toISOString().slice(0, 10),
    );

    // insertEvent result intentionally unused for routing — relaxed idempotency
    // means ad spend rows are always upserted (overwrite, not increment).
    await insertEvent(client, {
      event_id,
      event_type: event.event_type,
      source: 'integration-hub',
      entity_type: 'ad-spend',
      entity_id: event.entity_id,
      dimensions: { platform, location_id },
      properties: event.payload,
      occurred_at,
    });

    const records = Array.isArray(event.payload['records']) ? event.payload['records'] : [];
    for (const record of records) {
      const r = record as Record<string, unknown>;
      await upsertAdSpendDaily(client, {
        date: synced_date,
        platform,
        location_id,
        campaign_id: String(r['campaign_id'] ?? ''),
        campaign_name: String(r['campaign_name'] ?? ''),
        impressions: Number(r['impressions'] ?? 0),
        clicks: Number(r['clicks'] ?? 0),
        spend: Number(r['spend'] ?? 0),
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

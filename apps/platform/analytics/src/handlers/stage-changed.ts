import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';
import { insertEvent } from '../repositories/events.js';
import { upsertPipelineDaily, upsertCoordinatorDaily } from '../repositories/rollups.js';

export async function handleStageChanged(event: OrthoEvent, pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const event_id = event.event_id ?? randomUUID();
    const occurred_at =
      typeof event.payload['occurred_at'] === 'string'
        ? new Date(event.payload['occurred_at'])
        : new Date();

    const location_id = String(event.payload['location_id'] ?? '');
    const pipeline = String(event.payload['pipeline'] ?? '');
    const stage = String(event.payload['stage_to'] ?? '');
    const triggered_by =
      event.payload['triggered_by'] != null ? String(event.payload['triggered_by']) : null;
    const response_time_seconds =
      typeof event.payload['response_time_seconds'] === 'number'
        ? event.payload['response_time_seconds']
        : null;
    const time_in_stage_seconds =
      typeof event.payload['time_in_stage_seconds'] === 'number'
        ? (event.payload['time_in_stage_seconds'] as number)
        : 0;
    const date = occurred_at.toISOString().slice(0, 10);

    const { inserted } = await insertEvent(client, {
      event_id,
      event_type: event.event_type,
      source: 'pipeline-engine',
      entity_type: 'lead',
      entity_id: event.entity_id,
      dimensions: { location_id, pipeline, stage },
      properties: event.payload,
      occurred_at,
    });

    if (inserted) {
      await upsertPipelineDaily(client, { date, location_id, pipeline, stage, entries_delta: 1 });

      if (triggered_by !== null) {
        await upsertCoordinatorDaily(client, {
          date,
          location_id,
          coordinator_id: triggered_by,
          response_time_sum_delta:
            response_time_seconds !== null ? response_time_seconds : 0,
          response_time_count_delta: response_time_seconds !== null ? 1 : 0,
          time_in_stage_sum_delta: time_in_stage_seconds,
          time_in_stage_count_delta: 1,
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

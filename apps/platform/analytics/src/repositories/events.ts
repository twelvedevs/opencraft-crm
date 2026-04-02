import type { PoolClient } from 'pg';

export interface InsertEventParams {
  event_id: string;
  event_type: string;
  source: string;
  entity_type?: string;
  entity_id?: string;
  dimensions?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  occurred_at: Date;
}

export async function insertEvent(
  client: PoolClient,
  params: InsertEventParams,
): Promise<{ inserted: boolean }> {
  const result = await client.query(
    `INSERT INTO platform_analytics.analytics_events
       (event_id, event_type, source, entity_type, entity_id, dimensions, properties, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      params.event_id,
      params.event_type,
      params.source,
      params.entity_type ?? null,
      params.entity_id ?? null,
      JSON.stringify(params.dimensions ?? {}),
      JSON.stringify(params.properties ?? {}),
      params.occurred_at,
    ],
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}

import type { PoolClient } from 'pg';
import type { BackfillJob } from '../connectors/interface.js';

export async function insert(
  client: PoolClient,
  data: {
    account_id: string;
    from_date: string;
    to_date: string;
    chunks_total: number;
  },
): Promise<BackfillJob> {
  const result = await client.query<BackfillJob>(
    `INSERT INTO platform_integrations.backfill_jobs (account_id, from_date, to_date, chunks_total)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.account_id, data.from_date, data.to_date, data.chunks_total],
  );
  return result.rows[0];
}

export async function findById(
  client: PoolClient,
  id: string,
): Promise<BackfillJob | null> {
  const result = await client.query<BackfillJob>(
    'SELECT * FROM platform_integrations.backfill_jobs WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

export async function updateProgress(
  client: PoolClient,
  id: string,
  chunksDone: number,
): Promise<void> {
  await client.query(
    'UPDATE platform_integrations.backfill_jobs SET chunks_done = $1, updated_at = NOW() WHERE id = $2',
    [chunksDone, id],
  );
}

export async function setCompleted(client: PoolClient, id: string): Promise<void> {
  await client.query(
    "UPDATE platform_integrations.backfill_jobs SET status = 'completed', updated_at = NOW() WHERE id = $1",
    [id],
  );
}

export async function setFailed(client: PoolClient, id: string, error: string): Promise<void> {
  await client.query(
    "UPDATE platform_integrations.backfill_jobs SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2",
    [error, id],
  );
}

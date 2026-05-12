import type { PoolClient } from 'pg';

export async function insert(
  client: PoolClient,
  data: { platform: string; raw_body: string; error: string },
): Promise<void> {
  await client.query(
    `INSERT INTO platform_integrations.failed_webhooks (platform, raw_body, error)
     VALUES ($1, $2, $3)`,
    [data.platform, data.raw_body, data.error],
  );
}

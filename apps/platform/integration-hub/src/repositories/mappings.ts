import type { PoolClient } from 'pg';
import type { CampaignLocationMapping } from '../connectors/interface.js';

export async function findByAccountId(
  client: PoolClient,
  accountId: string,
): Promise<CampaignLocationMapping[]> {
  const result = await client.query<CampaignLocationMapping>(
    'SELECT * FROM platform_integrations.campaign_location_mappings WHERE account_id = $1',
    [accountId],
  );
  return result.rows;
}

export async function findByCampaignId(
  client: PoolClient,
  accountId: string,
  campaignId: string,
): Promise<CampaignLocationMapping | null> {
  const result = await client.query<CampaignLocationMapping>(
    'SELECT * FROM platform_integrations.campaign_location_mappings WHERE account_id = $1 AND campaign_id = $2',
    [accountId, campaignId],
  );
  return result.rows[0] ?? null;
}

export async function replaceAll(
  client: PoolClient,
  accountId: string,
  mappings: { campaign_id: string; location_id: string }[],
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      'DELETE FROM platform_integrations.campaign_location_mappings WHERE account_id = $1',
      [accountId],
    );
    for (const mapping of mappings) {
      await client.query(
        `INSERT INTO platform_integrations.campaign_location_mappings (account_id, campaign_id, location_id)
         VALUES ($1, $2, $3)`,
        [accountId, mapping.campaign_id, mapping.location_id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

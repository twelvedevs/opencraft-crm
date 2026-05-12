import type { PoolClient } from 'pg';
import type { IntegrationAccount } from '../connectors/interface.js';

export async function findAll(client: PoolClient): Promise<IntegrationAccount[]> {
  const result = await client.query<IntegrationAccount>(
    'SELECT * FROM platform_integrations.integration_accounts ORDER BY created_at DESC',
  );
  return result.rows;
}

export async function findById(client: PoolClient, id: string): Promise<IntegrationAccount | null> {
  const result = await client.query<IntegrationAccount>(
    'SELECT * FROM platform_integrations.integration_accounts WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findActiveAccounts(client: PoolClient): Promise<IntegrationAccount[]> {
  const result = await client.query<IntegrationAccount>(
    "SELECT * FROM platform_integrations.integration_accounts WHERE status != 'error' ORDER BY created_at DESC",
  );
  return result.rows;
}

export async function insert(
  client: PoolClient,
  data: {
    platform: string;
    account_id: string;
    account_name?: string | null;
    access_token: string;
    refresh_token?: string | null;
    token_expires_at?: Date | null;
  },
): Promise<IntegrationAccount> {
  const result = await client.query<IntegrationAccount>(
    `INSERT INTO platform_integrations.integration_accounts
       (platform, account_id, account_name, access_token, refresh_token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.platform,
      data.account_id,
      data.account_name ?? null,
      data.access_token,
      data.refresh_token ?? null,
      data.token_expires_at ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateTokens(
  client: PoolClient,
  id: string,
  tokens: {
    access_token: string;
    refresh_token?: string | null;
    token_expires_at?: Date | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE platform_integrations.integration_accounts
     SET access_token = $1, refresh_token = COALESCE($2, refresh_token), token_expires_at = $3
     WHERE id = $4`,
    [tokens.access_token, tokens.refresh_token ?? null, tokens.token_expires_at ?? null, id],
  );
}

export async function setError(client: PoolClient, id: string, error: string): Promise<void> {
  await client.query(
    "UPDATE platform_integrations.integration_accounts SET status = 'error', last_error = $1 WHERE id = $2",
    [error, id],
  );
}

export async function setLastPolled(client: PoolClient, id: string): Promise<void> {
  await client.query(
    "UPDATE platform_integrations.integration_accounts SET last_polled_at = NOW(), status = 'active', last_error = NULL WHERE id = $1",
    [id],
  );
}

export async function remove(client: PoolClient, id: string): Promise<void> {
  await client.query(
    'DELETE FROM platform_integrations.integration_accounts WHERE id = $1',
    [id],
  );
}

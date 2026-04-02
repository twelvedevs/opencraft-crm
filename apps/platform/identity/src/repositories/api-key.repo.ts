import type { Pool, PoolClient } from 'pg';
import type { ApiKey } from '../types.js';

type DbClient = Pool | PoolClient;

export async function createKey(
  client: DbClient,
  data: { name: string; key_hash: string; permissions: string[]; created_by?: string | null },
): Promise<ApiKey> {
  const result = await client.query(
    `INSERT INTO platform_identity.api_keys (name, key_hash, permissions, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.name, data.key_hash, data.permissions, data.created_by ?? null],
  );
  return result.rows[0];
}

export async function findByHash(client: DbClient, hash: string): Promise<ApiKey | null> {
  const result = await client.query(
    'SELECT * FROM platform_identity.api_keys WHERE key_hash = $1',
    [hash],
  );
  return result.rows[0] ?? null;
}

export async function listKeys(client: DbClient): Promise<ApiKey[]> {
  const result = await client.query(
    'SELECT * FROM platform_identity.api_keys',
  );
  return result.rows;
}

export async function revokeKey(client: DbClient, id: string): Promise<void> {
  await client.query(
    'UPDATE platform_identity.api_keys SET revoked_at = now() WHERE id = $1',
    [id],
  );
}

export async function touchLastUsed(client: DbClient, id: string): Promise<void> {
  await client.query(
    'UPDATE platform_identity.api_keys SET last_used_at = now() WHERE id = $1',
    [id],
  );
}

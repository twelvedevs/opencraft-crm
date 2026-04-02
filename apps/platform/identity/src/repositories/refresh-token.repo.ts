import type { Pool, PoolClient } from 'pg';
import type { RefreshToken } from '../types.js';

type DbClient = Pool | PoolClient;

export async function createToken(
  client: DbClient,
  data: { user_id: string; token_hash: string; expires_at: Date },
): Promise<RefreshToken> {
  const result = await client.query(
    `INSERT INTO platform_identity.refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [data.user_id, data.token_hash, data.expires_at],
  );
  return result.rows[0];
}

export async function findByHash(client: DbClient, hash: string): Promise<RefreshToken | null> {
  const result = await client.query(
    'SELECT * FROM platform_identity.refresh_tokens WHERE token_hash = $1',
    [hash],
  );
  return result.rows[0] ?? null;
}

export async function revokeToken(client: DbClient, id: string): Promise<void> {
  await client.query(
    'UPDATE platform_identity.refresh_tokens SET revoked_at = now() WHERE id = $1',
    [id],
  );
}

export async function revokeAllForUser(client: DbClient, userId: string): Promise<void> {
  await client.query(
    'UPDATE platform_identity.refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}

export async function pruneExpiredAndOldRevoked(client: DbClient): Promise<number> {
  const result = await client.query(
    `DELETE FROM platform_identity.refresh_tokens
     WHERE expires_at < now()
        OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
  );
  return result.rowCount ?? 0;
}

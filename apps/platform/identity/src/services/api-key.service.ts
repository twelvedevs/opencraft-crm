import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { ApiKey } from '../types.js';
import * as apiKeyRepo from '../repositories/api-key.repo.js';

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function generateApiKey(
  pool: Pool,
  data: { name: string; permissions: string[]; createdBy?: string },
): Promise<{ id: string; name: string; key: string; permissions: string[] }> {
  const raw = 'ak_' + crypto.randomBytes(32).toString('hex');
  const key_hash = hashKey(raw);

  const row = await apiKeyRepo.createKey(pool, {
    name: data.name,
    key_hash,
    permissions: data.permissions,
    created_by: data.createdBy ?? null,
  });

  return { id: row.id, name: row.name, key: raw, permissions: row.permissions };
}

export async function listApiKeys(pool: Pool): Promise<Omit<ApiKey, 'key_hash'>[]> {
  const rows = await apiKeyRepo.listKeys(pool);
  return rows
    .filter((r) => r.revoked_at === null)
    .map(({ key_hash, ...rest }) => rest);
}

export async function validateApiKey(
  pool: Pool,
  rawKey: string,
): Promise<{ permissions: string[] }> {
  const hash = hashKey(rawKey);
  const row = await apiKeyRepo.findByHash(pool, hash);

  if (!row || row.revoked_at !== null) {
    const err = new Error('invalid_key') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }

  // NOTE: The spec says last_used_at should only update on CRM API Gateway cache misses.
  // Since the Gateway caches /validate responses for 60 s, Identity Service cannot
  // distinguish cache-miss calls from cache-hit calls — it sees every gateway check.
  // last_used_at therefore reflects "last time the gateway validated with us", which
  // is an acceptable approximation. Resolving this precisely would require the gateway
  // to pass a cache-miss indicator header.
  await apiKeyRepo.touchLastUsed(pool, row.id);

  return { permissions: row.permissions };
}

export async function revokeApiKey(pool: Pool, id: string): Promise<void> {
  const rows = await pool.query(
    'SELECT id FROM platform_identity.api_keys WHERE id = $1',
    [id],
  );
  if (rows.rows.length === 0) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  await apiKeyRepo.revokeKey(pool, id);
}

import type { Pool, PoolClient } from 'pg';
import type { User } from '../types.js';

type DbClient = Pool | PoolClient;

export async function findById(client: DbClient, id: string): Promise<User | null> {
  const result = await client.query(
    'SELECT * FROM platform_identity.users WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findByEmail(client: DbClient, email: string): Promise<User | null> {
  const result = await client.query(
    'SELECT * FROM platform_identity.users WHERE email = $1',
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findByProviderUserId(client: DbClient, providerUserId: string): Promise<User | null> {
  const result = await client.query(
    'SELECT * FROM platform_identity.users WHERE provider_user_id = $1',
    [providerUserId],
  );
  return result.rows[0] ?? null;
}

export async function create(
  client: DbClient,
  data: {
    provider_user_id: string;
    email: string;
    name: string;
    role: string;
    status?: string;
    force_password_reset?: boolean;
    created_by?: string | null;
  },
): Promise<User> {
  const result = await client.query(
    `INSERT INTO platform_identity.users (provider_user_id, email, name, role, status, force_password_reset, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.provider_user_id,
      data.email,
      data.name,
      data.role,
      data.status ?? 'active',
      data.force_password_reset ?? true,
      data.created_by ?? null,
    ],
  );
  return result.rows[0];
}

export async function update(
  client: DbClient,
  id: string,
  data: Partial<Pick<User, 'name' | 'role' | 'status' | 'force_password_reset'>>,
): Promise<User> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${paramIdx++}`);
    values.push(data.name);
  }
  if (data.role !== undefined) {
    fields.push(`role = $${paramIdx++}`);
    values.push(data.role);
  }
  if (data.status !== undefined) {
    fields.push(`status = $${paramIdx++}`);
    values.push(data.status);
  }
  if (data.force_password_reset !== undefined) {
    fields.push(`force_password_reset = $${paramIdx++}`);
    values.push(data.force_password_reset);
  }

  fields.push(`updated_at = now()`);
  values.push(id);

  const result = await client.query(
    `UPDATE platform_identity.users SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function listUsers(
  client: DbClient,
  filters: { role?: string; status?: string; cursor?: string; limit?: number },
): Promise<{ rows: User[]; nextCursor: string | null }> {
  const limit = filters.limit ?? 50;
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (filters.role) {
    conditions.push(`role = $${paramIdx++}`);
    values.push(filters.role);
  }
  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    values.push(filters.status);
  }
  if (filters.cursor) {
    const decoded = JSON.parse(Buffer.from(filters.cursor, 'base64').toString()) as {
      created_at: string;
      id: string;
    };
    conditions.push(`(created_at, id) > ($${paramIdx++}, $${paramIdx++})`);
    values.push(decoded.created_at, decoded.id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit + 1);

  const result = await client.query(
    `SELECT * FROM platform_identity.users ${where} ORDER BY created_at, id LIMIT $${paramIdx}`,
    values,
  );

  const rows = result.rows.slice(0, limit);
  let nextCursor: string | null = null;
  if (result.rows.length > limit) {
    const last = rows[rows.length - 1];
    // Date.toISOString() preserves millisecond precision, which matches PostgreSQL's
    // timestamptz → JS Date conversion. Microseconds are truncated by the pg driver
    // before they reach us, so the cursor is stable across serialization round-trips.
    nextCursor = Buffer.from(
      JSON.stringify({ created_at: last.created_at, id: last.id }),
    ).toString('base64');
  }

  return { rows, nextCursor };
}

export async function getUserLocations(client: DbClient, userId: string): Promise<string[]> {
  const result = await client.query(
    'SELECT location_id FROM platform_identity.user_locations WHERE user_id = $1',
    [userId],
  );
  return result.rows.map((row: { location_id: string }) => row.location_id);
}

export async function setUserLocations(
  client: DbClient,
  userId: string,
  locationIds: string[],
): Promise<void> {
  await client.query(
    'DELETE FROM platform_identity.user_locations WHERE user_id = $1',
    [userId],
  );
  if (locationIds.length > 0) {
    const placeholders = locationIds
      .map((_, i) => `($1, $${i + 2})`)
      .join(', ');
    await client.query(
      `INSERT INTO platform_identity.user_locations (user_id, location_id) VALUES ${placeholders}`,
      [userId, ...locationIds],
    );
  }
}

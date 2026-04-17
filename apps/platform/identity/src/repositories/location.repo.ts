import type { Pool } from 'pg';

export type Location = {
  id: string;
  name: string;
  phone: string;
  address: string;
  timezone: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
};

export async function findAll(pool: Pool, status?: string): Promise<Location[]> {
  const values: unknown[] = [];
  let sql = 'SELECT * FROM platform_identity.locations';
  if (status !== undefined) {
    values.push(status);
    sql += ' WHERE status = $1';
  }
  sql += ' ORDER BY name';
  const result = await pool.query(sql, values);
  return result.rows;
}

export async function findById(pool: Pool, id: string): Promise<Location | null> {
  const result = await pool.query(
    'SELECT * FROM platform_identity.locations WHERE id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

export async function create(
  pool: Pool,
  data: { name: string; phone: string; address: string; timezone: string },
): Promise<Location> {
  const result = await pool.query(
    `INSERT INTO platform_identity.locations (name, phone, address, timezone)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.name, data.phone, data.address, data.timezone],
  );
  return result.rows[0];
}

export async function update(
  pool: Pool,
  id: string,
  data: Partial<{ name: string; phone: string; address: string; timezone: string; status: string }>,
): Promise<Location | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (data.name !== undefined) { fields.push(`name = $${paramIdx++}`); values.push(data.name); }
  if (data.phone !== undefined) { fields.push(`phone = $${paramIdx++}`); values.push(data.phone); }
  if (data.address !== undefined) { fields.push(`address = $${paramIdx++}`); values.push(data.address); }
  if (data.timezone !== undefined) { fields.push(`timezone = $${paramIdx++}`); values.push(data.timezone); }
  if (data.status !== undefined) { fields.push(`status = $${paramIdx++}`); values.push(data.status); }

  if (fields.length === 0) return findById(pool, id);

  fields.push(`updated_at = now()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE platform_identity.locations SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function softDelete(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE platform_identity.locations SET status = 'inactive', updated_at = now() WHERE id = $1 RETURNING id`,
    [id],
  );
  return result.rows.length > 0;
}

import type { Knex } from 'knex';

export interface PortalToken {
  id: string;
  referrer_id: string;
  token: string;
  created_by: string;
  created_at: Date;
}

const TABLE = 'portal_tokens';

export async function findByToken(db: Knex, token: string): Promise<PortalToken | null> {
  const row = await db(TABLE).where({ token }).first();
  return (row as PortalToken) ?? null;
}

export async function findByReferrerId(db: Knex, referrerId: string): Promise<PortalToken | null> {
  const row = await db(TABLE).where({ referrer_id: referrerId }).first();
  return (row as PortalToken) ?? null;
}

export async function upsertForReferrer(
  db: Knex,
  data: {
    referrer_id: string;
    created_by: string;
  },
): Promise<PortalToken> {
  const [row] = await db(TABLE)
    .insert(data)
    .onConflict('referrer_id')
    .merge({
      token: db.raw('gen_random_uuid()'),
      created_by: data.created_by,
      created_at: db.fn.now(),
    })
    .returning('*');
  return row as PortalToken;
}

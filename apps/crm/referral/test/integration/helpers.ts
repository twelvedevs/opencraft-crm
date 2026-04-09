import knexLib, { type Knex } from 'knex';
import { randomUUID } from 'node:crypto';

// Check if a real DB is available (not the fallback dummy URL)
const DATABASE_URL = process.env['DATABASE_URL'];
export const HAS_DB = !!DATABASE_URL && DATABASE_URL !== 'postgresql://localhost:5432/test';

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';

let db: Knex | undefined;

export function getDb(): Knex {
  if (!db) {
    db = knexLib({
      client: 'pg',
      connection: DATABASE_URL!,
      searchPath: ['crm_referrals', 'public'],
    });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_referrals',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.rollback(
    {
      directory: './migrations',
      schemaName: 'crm_referrals',
      tableName: 'knex_migrations',
      loadExtensions: ['.ts'],
    },
    true,
  );
}

export async function cleanup(): Promise<void> {
  if (db) {
    await rollbackMigrations();
    await db.destroy();
    db = undefined;
  }
}

export async function truncateTables(): Promise<void> {
  const knex = getDb();
  await knex.raw(
    'TRUNCATE crm_referrals.portal_tokens, crm_referrals.reward_events, crm_referrals.referrals, crm_referrals.referral_links, crm_referrals.referrers CASCADE',
  );
}

// ─── Factories ──────────────────────────────────────────────

export async function insertReferrer(
  dbConn: Knex,
  overrides: Partial<{
    referrer_type: string;
    lead_id: string | null;
    location_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    practice_name: string | null;
    address: string | null;
    status: string;
    created_by: string | null;
  }> = {},
): Promise<Record<string, unknown>> {
  const defaults = {
    referrer_type: 'patient',
    lead_id: null,
    location_id: LOCATION_ID,
    name: 'Test Referrer',
    phone: '+15551234567',
    email: null,
    practice_name: null,
    address: null,
    created_by: null,
  };
  const data = { ...defaults, ...overrides };
  const [row] = await dbConn('referrers').insert(data).returning('*');
  return row as Record<string, unknown>;
}

export async function insertReferralLink(
  dbConn: Knex,
  overrides: Partial<{
    referrer_id: string;
    code: string;
    redirect_url: string;
    click_count: number;
    status: string;
    created_by: string | null;
  }> & { referrer_id: string },
): Promise<Record<string, unknown>> {
  const defaults = {
    code: `CODE${randomUUID().slice(0, 4).toUpperCase()}`,
    redirect_url: 'https://example.com/referrals',
    created_by: null,
  };
  const data = { ...defaults, ...overrides };
  const [row] = await dbConn('referral_links').insert(data).returning('*');
  return row as Record<string, unknown>;
}

export async function insertReferral(
  dbConn: Knex,
  overrides: Partial<{
    referral_link_id: string;
    referrer_id: string;
    lead_id: string;
    location_id: string;
    status: string;
    exam_scheduled_at: string | null;
    converted_at: string | null;
    notify_on_exam: boolean;
    notify_on_conversion: boolean;
  }> & { referral_link_id: string; referrer_id: string; lead_id: string },
): Promise<Record<string, unknown>> {
  const defaults = {
    location_id: LOCATION_ID,
  };
  const data = { ...defaults, ...overrides };
  const [row] = await dbConn('referrals').insert(data).returning('*');
  return row as Record<string, unknown>;
}

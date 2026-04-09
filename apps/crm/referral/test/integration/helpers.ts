import knexLib, { type Knex } from 'knex';
import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createSigner } from 'fast-jwt';
import { createLogger } from '@ortho/logger';

// Route imports
import { publicLinksRoutes } from '../../src/routes/public/links.js';
import { publicPortalRoutes } from '../../src/routes/public/portal.js';
import { referrersRoutes } from '../../src/routes/referrers.js';
import { referralLinksRoutes } from '../../src/routes/referral-links.js';
import { referralsRoutes } from '../../src/routes/referrals.js';
import { rewardsRoutes } from '../../src/routes/rewards.js';
import { leaderboardRoutes } from '../../src/routes/leaderboard.js';

// ─── JWT / JWKS infrastructure ─────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const jwk = createPublicKey(publicKey as string).export({ format: 'jwk' });
const TEST_KID = 'test-key-1';
const JWKS_RESPONSE = JSON.stringify({
  keys: [{ ...jwk, kid: TEST_KID, use: 'sig', alg: 'RS256' }],
});

const sign = createSigner({ key: privateKey as string, algorithm: 'RS256', kid: TEST_KID });

export function makeJwt(payload?: {
  sub?: string;
  role?: string;
  locations?: string[];
}): string {
  return sign({
    sub: payload?.sub ?? 'test-user-1',
    role: payload?.role ?? 'marketing_staff',
    locations: payload?.locations ?? [LOCATION_ID],
    must_change_password: false,
  });
}

function jwksFetch(input: string | URL | Request): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
    return Promise.resolve(
      new Response(JWKS_RESPONSE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  // Default: return OK for any other HTTP call (messaging service, etc.)
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

let savedFetch: typeof globalThis.fetch | undefined;

export async function buildTestApp(): Promise<FastifyInstance> {
  savedFetch = globalThis.fetch;
  globalThis.fetch = jwksFetch as typeof globalThis.fetch;

  const log = createLogger('crm-referral-test');
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
  });

  await app.register(sensible);

  const testDb = getDb();

  // Public routes — encapsulated scope, no auth
  await app.register(async (scope) => {
    await scope.register(publicLinksRoutes, { db: testDb });
    await scope.register(publicPortalRoutes, { db: testDb });
  });

  // Staff routes — encapsulated scope with auth
  await app.register(async (scope) => {
    await scope.register(authPlugin, { jwksUrl: 'http://localhost:9999/.well-known/jwks.json' });

    await scope.register(referrersRoutes, { prefix: '/referrals/referrers', db: testDb });
    await scope.register(referralLinksRoutes, { prefix: '/referrals', db: testDb });
    await scope.register(referralsRoutes, { prefix: '/referrals', db: testDb });
    await scope.register(rewardsRoutes, { prefix: '/referrals', db: testDb });
    await scope.register(leaderboardRoutes, { prefix: '/referrals', db: testDb });
  });

  return app;
}

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

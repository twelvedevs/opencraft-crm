import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import knexLib, { type Knex } from 'knex';
import { createSigner } from 'fast-jwt';
import { createLogger } from '@ortho/logger';
import { campaignsRoutes } from '../../src/routes/campaigns.js';
import { workflowRoutes } from '../../src/routes/workflow.js';
import { commentsRoutes } from '../../src/routes/comments.js';

// Check if a real DB is available (not the fallback dummy URL)
const DATABASE_URL = process.env['DATABASE_URL'];
export const HAS_DB = !!DATABASE_URL && DATABASE_URL !== 'postgresql://localhost:5432/test';

// RSA keypair for signing test JWTs
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

export function makeJwt(payload: {
  sub?: string;
  role?: string;
  locations?: string[];
  must_change_password?: boolean;
}): string {
  return sign({
    sub: payload.sub ?? 'test-user-1',
    role: payload.role ?? 'marketing_staff',
    locations: payload.locations ?? [LOCATION_ID],
    must_change_password: payload.must_change_password ?? false,
  });
}

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const USER_ID = 'test-user-1';
export const MANAGER_ID = 'test-manager-1';

let db: Knex | undefined;

export function getDb(): Knex {
  if (!db) {
    db = knexLib({
      client: 'pg',
      connection: DATABASE_URL!,
      searchPath: ['crm_campaigns', 'public'],
    });
  }
  return db;
}

// Mock global fetch to intercept JWKS requests
const originalFetch = globalThis.fetch;

function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
    return Promise.resolve(new Response(JWKS_RESPONSE, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  return originalFetch(input, init);
}

export async function buildTestApp(): Promise<FastifyInstance> {
  globalThis.fetch = mockFetch as typeof globalThis.fetch;

  const log = createLogger('crm-campaign-test');
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
  });

  await app.register(sensible);

  await app.register(authPlugin, {
    jwksUrl: 'http://localhost:9999/.well-known/jwks.json',
    allowedPaths: ['/health'],
  });

  app.get('/health', async () => ({ ok: true }));

  const testDb = getDb();
  await app.register(campaignsRoutes, { prefix: '/campaigns', db: testDb });
  await app.register(workflowRoutes, { prefix: '/campaigns', db: testDb });
  await app.register(commentsRoutes, { prefix: '/campaigns', db: testDb });

  return app;
}

export async function runMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_campaigns',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.rollback({
    directory: './migrations',
    schemaName: 'crm_campaigns',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  }, true);
}

export async function cleanup(): Promise<void> {
  if (db) {
    await rollbackMigrations();
    await db.destroy();
    db = undefined;
  }
  globalThis.fetch = originalFetch;
}

export async function truncateTables(): Promise<void> {
  const knex = getDb();
  await knex.raw(
    'TRUNCATE crm_campaigns.campaign_conversions, crm_campaigns.campaign_recipients, crm_campaigns.campaign_sends, crm_campaigns.campaign_comments, crm_campaigns.campaign_events, crm_campaigns.campaigns CASCADE',
  );
}

// ─── Factories ──────────────────────────────────────────────

export interface InsertCampaignOverrides {
  name?: string;
  status?: string;
  template_id?: string;
  subject?: string | null;
  segment_id?: string | null;
  audience_filter?: Record<string, unknown> | null;
  created_by?: string;
  approved_by?: string | null;
  approved_at?: Date | null;
  scheduled_for?: Date | null;
  [key: string]: unknown;
}

export async function insertCampaign(
  dbConn: Knex,
  overrides: InsertCampaignOverrides = {},
): Promise<Record<string, unknown>> {
  const defaults = {
    name: 'Test Campaign',
    template_id: '00000000-0000-0000-0000-000000000100',
    subject: 'Test Subject',
    segment_id: '00000000-0000-0000-0000-000000000200',
    created_by: USER_ID,
  };

  const data = { ...defaults, ...overrides };

  const [row] = await dbConn('campaigns').insert(data).returning('*');
  return row as Record<string, unknown>;
}

export async function insertCampaignEvent(
  dbConn: Knex,
  overrides: {
    campaign_id: string;
    from_status?: string | null;
    to_status: string;
    actor_id?: string | null;
    comment?: string | null;
  },
): Promise<Record<string, unknown>> {
  const [row] = await dbConn('campaign_events')
    .insert({
      from_status: null,
      actor_id: USER_ID,
      ...overrides,
    })
    .returning('*');
  return row as Record<string, unknown>;
}

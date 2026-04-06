import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import knexLib, { type Knex } from 'knex';
import { createSigner } from 'fast-jwt';
import { createLogger } from '@ortho/logger';
import { leadsRoutes } from '../../src/routes/leads.js';
import { appointmentRoutes } from '../../src/routes/appointments.js';
import { tagRoutes } from '../../src/routes/tags.js';
import { activityRoutes } from '../../src/routes/activities.js';

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
    role: payload.role ?? 'call_center_agent',
    locations: payload.locations ?? [LOCATION_ID],
    must_change_password: payload.must_change_password ?? false,
  });
}

export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const LOCATION_ID_2 = '00000000-0000-0000-0000-000000000002';

let db: Knex | undefined;

export function getDb(): Knex {
  if (!db) {
    db = knexLib({
      client: 'pg',
      connection: DATABASE_URL!,
      searchPath: ['crm_leads', 'public'],
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

  const log = createLogger('crm-lead-test');
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
  await app.register(leadsRoutes, { db: testDb });
  await app.register(appointmentRoutes, { db: testDb });
  await app.register(tagRoutes, { db: testDb });
  await app.register(activityRoutes, { db: testDb });

  return app;
}

export async function runMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_leads',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.rollback({
    directory: './migrations',
    schemaName: 'crm_leads',
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
  await knex.raw('TRUNCATE crm_leads.lead_merges, crm_leads.lead_tags, crm_leads.lead_activities, crm_leads.appointments, crm_leads.tags, crm_leads.leads CASCADE');
}

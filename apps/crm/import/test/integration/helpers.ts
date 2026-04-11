import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import knexLib, { type Knex } from 'knex';
import { Readable } from 'node:stream';
import { createSigner } from 'fast-jwt';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PipelineEngineClient } from '../../src/clients/pipeline-engine.js';

// Check if a real DB is available (not the fallback dummy URL)
const DATABASE_URL = process.env['DATABASE_URL'];
export const HAS_DB = !!DATABASE_URL && DATABASE_URL !== 'postgresql://localhost:5432/test_imports';

// Test constants
export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const USER_ID = '00000000-0000-0000-0000-000000000099';
export const LEAD_ID_1 = '00000000-0000-0000-0000-000000000010';
export const LEAD_ID_2 = '00000000-0000-0000-0000-000000000020';
export const LEAD_ID_3 = '00000000-0000-0000-0000-000000000030';
export const LEAD_SERVICE_URL = 'http://localhost:4002';

let db: Knex | undefined;

export function getDb(): Knex {
  if (!db) {
    db = knexLib({
      client: 'pg',
      connection: DATABASE_URL!,
      searchPath: ['crm_imports', 'public'],
    });
  }
  return db;
}

export async function runMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_imports',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.rollback(
    {
      directory: './migrations',
      schemaName: 'crm_imports',
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
    'TRUNCATE crm_imports.import_rows, crm_imports.imports, crm_imports.column_mappings CASCADE',
  );
}

/**
 * Create a mock S3 client that returns the given CSV content as a readable stream.
 */
export function createMockS3Client(csvContent: string): S3Client {
  return {
    send: async () => ({
      Body: Readable.from(csvContent),
    }),
  } as unknown as S3Client;
}

/**
 * Create a mock S3 client that throws on send (simulates S3 failure).
 */
export function createFailingS3Client(errorMessage = 'S3 access denied'): S3Client {
  return {
    send: async () => {
      throw new Error(errorMessage);
    },
  } as unknown as S3Client;
}

/**
 * Create a mock PipelineEngineClient (not used in parse_match phase).
 */
export function createMockPipelineClient(): PipelineEngineClient {
  return {} as unknown as PipelineEngineClient;
}

/**
 * Create a silent pino logger for tests.
 */
export function createSilentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => createSilentLogger(),
  } as unknown as import('pino').Logger;
}

// ---------------------------------------------------------------------------
// JWT / JWKS helpers for route integration tests
// ---------------------------------------------------------------------------

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
  must_change_password?: boolean;
}): string {
  return sign({
    sub: payload?.sub ?? USER_ID,
    role: payload?.role ?? 'call_center_manager',
    locations: payload?.locations ?? [LOCATION_ID],
    must_change_password: payload?.must_change_password ?? false,
  });
}

const originalFetch = globalThis.fetch;

function jwksMockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
    return Promise.resolve(
      new Response(JWKS_RESPONSE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  return originalFetch(input, init);
}

export function mockFetchForJwks(): void {
  globalThis.fetch = jwksMockFetch as typeof globalThis.fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

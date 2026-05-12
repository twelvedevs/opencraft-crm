import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthProvider } from '../../src/providers/auth-provider.interface.js';

// Generate RSA key pair for test JWT signing
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
const jwksKeys = [{ ...jwk, kid: 'test-kid-1', use: 'sig', alg: 'RS256' }];

export { privateKey, publicKey, jwksKeys };

const JWKS_URL = 'http://localhost:9999/identity/.well-known/jwks.json';

/**
 * Warn loudly when integration tests will be skipped due to missing DATABASE_URL.
 * Call this at the top of every integration test file (before describe.skipIf).
 */
export function warnIfSkipped(): void {
  if (!process.env['DATABASE_URL']) {
    console.warn(
      '\n[identity integration] DATABASE_URL not set — all tests in this file will be SKIPPED.\n' +
      'Set DATABASE_URL to run the full integration suite.\n',
    );
  }
}

/**
 * Set all env vars needed before importing app.ts / env.ts / token.service.ts.
 * Must be called BEFORE any dynamic import of those modules.
 */
export function setTestEnv(): void {
  // DATABASE_URL must be set externally; tests skip via describe.skipIf when absent
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['AUTH_PROVIDER'] = 'supabase';
  process.env['SUPABASE_URL'] = 'https://fake.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'fake-service-role-key';
  process.env['IDENTITY_PRIVATE_KEY'] = privateKey;
  process.env['IDENTITY_JWKS_KEYS'] = JSON.stringify(jwksKeys);
  process.env['IDENTITY_JWKS_URL'] = JWKS_URL;
  process.env['INTERNAL_API_SECRET'] = 'test-internal-secret';
  process.env['CORS_ORIGIN'] = 'http://localhost:3000';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['PASSWORD_MIN_LENGTH'] = '8';
  process.env['PASSWORD_REQUIRE_UPPERCASE'] = 'true';
  process.env['PASSWORD_REQUIRE_LOWERCASE'] = 'true';
  process.env['PASSWORD_REQUIRE_NUMBER'] = 'true';
  process.env['PASSWORD_REQUIRE_SPECIAL'] = 'true';
}

/**
 * Mock global.fetch so the authPlugin JWKS fetch returns our test keys.
 * Call this BEFORE importing/building the app.
 */
export function mockJwksFetch(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({ keys: jwksKeys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

/** Raw SQL to create schema and tables for tests (mirrors migrations) */
export async function createSchema(pool: Pool): Promise<void> {
  await pool.query('CREATE SCHEMA IF NOT EXISTS platform_identity');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_user_id varchar UNIQUE NOT NULL,
      email varchar UNIQUE NOT NULL,
      name varchar NOT NULL,
      role varchar NOT NULL CHECK (role IN ('call_center_agent','call_center_manager','marketing_staff','marketing_manager','super_admin')),
      status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      force_password_reset boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES platform_identity.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar NOT NULL,
      phone varchar NOT NULL,
      address varchar NOT NULL,
      timezone varchar NOT NULL,
      status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.user_locations (
      user_id uuid REFERENCES platform_identity.users(id) ON DELETE CASCADE,
      location_id uuid NOT NULL REFERENCES platform_identity.locations(id) ON DELETE RESTRICT,
      PRIMARY KEY (user_id, location_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES platform_identity.users(id) ON DELETE CASCADE,
      token_hash varchar UNIQUE NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_identity.api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar NOT NULL,
      key_hash varchar UNIQUE NOT NULL,
      permissions varchar[] NOT NULL,
      created_by uuid REFERENCES platform_identity.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )
  `);
}

/** Truncate all tables in reverse FK order */
export async function truncateTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE platform_identity.api_keys CASCADE');
  await pool.query('TRUNCATE platform_identity.refresh_tokens CASCADE');
  await pool.query('TRUNCATE platform_identity.user_locations CASCADE');
  await pool.query('TRUNCATE platform_identity.users CASCADE');
  await pool.query('TRUNCATE platform_identity.locations CASCADE');
}

/** Create a mock AuthProvider for integration tests */
export function createMockProvider(): AuthProvider {
  return {
    verifyToken: async (_token: string) => ({ providerUserId: 'provider-user-1', email: 'test@example.com' }),
    createUser: async (_email: string, _password: string) => ({ providerUserId: `provider-${Date.now()}` }),
    setPassword: async () => {},
    deactivateUser: async () => {},
    signInWithPassword: async () => {},
  };
}

/**
 * Insert a test user directly into the DB.
 * Returns the user row.
 */
export async function insertTestUser(
  pool: Pool,
  overrides: Partial<{
    provider_user_id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    force_password_reset: boolean;
  }> = {},
): Promise<{
  id: string;
  provider_user_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  force_password_reset: boolean;
}> {
  const result = await pool.query(
    `INSERT INTO platform_identity.users (provider_user_id, email, name, role, status, force_password_reset)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      overrides.provider_user_id ?? 'provider-user-1',
      overrides.email ?? 'test@example.com',
      overrides.name ?? 'Test User',
      overrides.role ?? 'super_admin',
      overrides.status ?? 'active',
      overrides.force_password_reset ?? false,
    ],
  );
  return result.rows[0];
}

export async function insertTestLocation(
  pool: Pool,
  overrides: Partial<{
    name: string;
    phone: string;
    address: string;
    timezone: string;
    status: string;
  }> = {},
): Promise<{ id: string; name: string; phone: string; address: string; timezone: string; status: string }> {
  const result = await pool.query(
    `INSERT INTO platform_identity.locations (name, phone, address, timezone, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      overrides.name ?? 'Test Location',
      overrides.phone ?? '+15550000000',
      overrides.address ?? '1 Test St, New York, NY 10001',
      overrides.timezone ?? 'America/New_York',
      overrides.status ?? 'active',
    ],
  );
  return result.rows[0];
}

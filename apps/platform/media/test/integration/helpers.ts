import { generateKeyPairSync, createPublicKey, createSign } from 'node:crypto';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// RSA key pair for test JWT signing
// ---------------------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
const jwksKeys = [{ ...jwk, kid: 'test-kid-1', use: 'sig', alg: 'RS256' }];

const JWKS_URL = 'http://localhost:9999/.well-known/jwks.json';

// ---------------------------------------------------------------------------
// Warn when integration tests are skipped
// ---------------------------------------------------------------------------
export function warnIfSkipped(): void {
  if (!process.env['DATABASE_URL']) {
    console.warn(
      '\n[media integration] DATABASE_URL not set — all tests in this file will be SKIPPED.\n' +
        'Set DATABASE_URL to run the full integration suite.\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Set env vars before importing app modules
// ---------------------------------------------------------------------------
export function setTestEnv(): void {
  process.env['AWS_REGION'] = 'us-east-1';
  process.env['S3_PUBLIC_BUCKET'] = 'test-public';
  process.env['S3_PRIVATE_BUCKET'] = 'test-private';
  process.env['CLOUDFRONT_BASE_URL'] = 'https://cdn.test.com';
  process.env['SERVICE_AUTH_TOKEN'] = 'test-service-token';
  process.env['SERVICE_CALLER_ID'] = 'test-service-caller';
  process.env['PRESIGNED_PUT_TTL_SECONDS'] = '900';
  process.env['PRESIGNED_GET_TTL_SECONDS'] = '900';
  process.env['MAX_FILE_SIZE_BYTES'] = '20971520';
  process.env['CORS_ORIGIN'] = '*';
  process.env['IDENTITY_JWKS_URL'] = JWKS_URL;
  process.env['LOG_LEVEL'] = 'silent';
  process.env['PORT'] = '0';
}

// ---------------------------------------------------------------------------
// Mock global.fetch for JWKS endpoint
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// JWT signing helper
// ---------------------------------------------------------------------------
export function signTestToken(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: now, exp: now + 3600, ...payload };

  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid-1' }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  const signature = signer.sign(privateKey, 'base64url');

  return `${header}.${body}.${signature}`;
}

// ---------------------------------------------------------------------------
// Schema creation (mirrors migrations)
// ---------------------------------------------------------------------------
export async function createSchema(pool: Pool): Promise<void> {
  await pool.query('CREATE SCHEMA IF NOT EXISTS platform_media');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_media.media_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id uuid UNIQUE NOT NULL,
      tier text NOT NULL CHECK (tier IN ('public','private')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','deleted')),
      mime_type text NOT NULL,
      original_key text NOT NULL,
      original_filename text NOT NULL,
      file_size_bytes bigint,
      location_id uuid,
      purpose text,
      uploaded_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      confirmed_at timestamptz,
      deleted_at timestamptz
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_media.media_variants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id uuid NOT NULL REFERENCES platform_media.media_files(id),
      variant text NOT NULL CHECK (variant IN ('medium','thumb')),
      s3_key text NOT NULL,
      width_px int NOT NULL,
      size_bytes bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(file_id, variant)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_media.media_upload_intents (
      id uuid PRIMARY KEY,
      file_id uuid NOT NULL REFERENCES platform_media.media_files(id),
      presigned_url text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

// ---------------------------------------------------------------------------
// Table truncation
// ---------------------------------------------------------------------------
export async function truncateTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE platform_media.media_upload_intents CASCADE');
  await pool.query('TRUNCATE platform_media.media_variants CASCADE');
  await pool.query('TRUNCATE platform_media.media_files CASCADE');
}

// ---------------------------------------------------------------------------
// Minimal valid 1x1 white PNG for image processing tests
// ---------------------------------------------------------------------------
export const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------------------
// Multipart body builder for Fastify inject
// ---------------------------------------------------------------------------
export function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; data: Buffer; contentType: string },
): { body: Buffer; contentType: string } {
  const boundary = '----TestBoundary' + Date.now();
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

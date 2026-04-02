import pg from 'pg';
import { validatePassword } from '../src/lib/password-policy.js';
import { createAuthProvider } from '../src/providers/index.js';

const SEED_EMAIL = process.env['SEED_EMAIL'];
const SEED_PASSWORD = process.env['SEED_PASSWORD'];
const AUTH_PROVIDER = process.env['AUTH_PROVIDER'];
const DATABASE_URL = process.env['DATABASE_URL'];

if (!SEED_EMAIL || !SEED_PASSWORD) {
  console.error('Missing required env vars: SEED_EMAIL and SEED_PASSWORD');
  process.exit(1);
}
if (!AUTH_PROVIDER) {
  console.error('Missing required env var: AUTH_PROVIDER');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing required env var: DATABASE_URL');
  process.exit(1);
}

// Validate password against policy
const { valid, errors } = validatePassword(SEED_PASSWORD);
if (!valid) {
  console.error('Password does not meet policy requirements:');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

const provider = createAuthProvider(AUTH_PROVIDER);

let providerUserId: string;
try {
  const result = await provider.createUser(SEED_EMAIL, SEED_PASSWORD);
  providerUserId = result.providerUserId;
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes('duplicate') || message.toLowerCase().includes('already exists') || message.toLowerCase().includes('conflict')) {
    console.error(`User with email ${SEED_EMAIL} already exists in auth provider`);
    process.exit(1);
  }
  throw err;
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

try {
  const result = await pool.query(
    `INSERT INTO platform_identity.users (provider_user_id, email, name, role, status, force_password_reset, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [providerUserId, SEED_EMAIL, 'Super Admin', 'super_admin', 'active', true, null],
  );

  if (result.rows.length > 0) {
    console.log(result.rows[0].id);
  } else {
    console.log(`User with email ${SEED_EMAIL} already exists in database (no row inserted)`);
  }
} finally {
  await pool.end();
}

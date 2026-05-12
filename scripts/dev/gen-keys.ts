import { generateKeyPairSync, createPublicKey, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve to monorepo root .env (two levels up from scripts/dev/)
const envPath = resolve(__dirname, '../../.env');

// ── Identity RSA keypair ────────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;
jwk.kid = 'dev-1';
jwk.use = 'sig';
jwk.alg = 'RS256';

// ── GoTrue service_role JWT ─────────────────────────────────────────────────
// Read the JWT secret from .env if it exists, otherwise use the default from .env.example
let gotrueSecret = 'super-secret-jwt-token-with-at-least-32-chars';
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const line = lines.find((l) => l.startsWith('GoTrue__JWT_Secret='));
  if (line) gotrueSecret = line.split('=').slice(1).join('=');
}

const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(
  JSON.stringify({
    role: 'service_role',
    iss: 'supabase-demo',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600, // 10 years
  }),
).toString('base64url');
const sig = createHmac('sha256', gotrueSecret).update(`${header}.${payload}`).digest('base64url');
const serviceRoleKey = `${header}.${payload}.${sig}`;

// ── Integration Hub AES-256 encryption key ──────────────────────────────────
const integrationHubEncryptionKey = randomBytes(32).toString('base64');

// ── Merge into .env ─────────────────────────────────────────────────────────
const newVars: Record<string, string> = {
  'Identity__Private_Key': privateKey,
  'Identity__JWKS_Keys': JSON.stringify([jwk]),
  'GoTrue__Service_Role_Key': serviceRoleKey,
  'Integration_Hub__Encryption_Key': integrationHubEncryptionKey,
};

let existingLines: string[] = [];
if (existsSync(envPath)) {
  existingLines = readFileSync(envPath, 'utf-8').split('\n');
}

for (const [key, value] of Object.entries(newVars)) {
  const idx = existingLines.findIndex((line) => line.startsWith(`${key}=`));
  // Multiline values (PEM keys) are double-quote-wrapped with \n escaping
  const escaped = value.includes('\n') ? `"${value.replace(/\n/g, '\\n')}"` : value;
  const entry = `${key}=${escaped}`;
  if (idx >= 0) {
    existingLines[idx] = entry;
  } else {
    existingLines.push(entry);
  }
}

while (existingLines.length > 0 && existingLines[existingLines.length - 1] === '') {
  existingLines.pop();
}
existingLines.push('');

writeFileSync(envPath, existingLines.join('\n'));

console.log('Keys written to .env:');
console.log('  Identity__Private_Key: RSA-2048 PKCS#1 PEM');
console.log('  Identity__JWKS_Keys: JWK array with kid=dev-1');
console.log('  GoTrue__Service_Role_Key: HS256 JWT, 10-year expiry');
console.log('  Integration_Hub__Encryption_Key: AES-256 random key (base64)');
console.log(`  Path: ${envPath}`);

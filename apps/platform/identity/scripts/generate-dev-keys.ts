import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

// Generate RSA-2048 key pair
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

// Convert public key to JWK
const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;
jwk.kid = 'dev-1';
jwk.use = 'sig';
jwk.alg = 'RS256';

const jwksKeys = JSON.stringify([jwk]);

// Merge into .env file
const newVars: Record<string, string> = {
  IDENTITY_PRIVATE_KEY: privateKey,
  IDENTITY_JWKS_KEYS: jwksKeys,
};

let existingLines: string[] = [];
if (existsSync(envPath)) {
  existingLines = readFileSync(envPath, 'utf-8').split('\n');
}

for (const [key, value] of Object.entries(newVars)) {
  const idx = existingLines.findIndex((line) => line.startsWith(`${key}=`));
  // For multiline PEM, use double-quote wrapping with literal \n
  const escaped = value.includes('\n') ? `"${value.replace(/\n/g, '\\n')}"` : value;
  const entry = `${key}=${escaped}`;
  if (idx >= 0) {
    existingLines[idx] = entry;
  } else {
    existingLines.push(entry);
  }
}

// Remove trailing empty lines, then add one final newline
while (existingLines.length > 0 && existingLines[existingLines.length - 1] === '') {
  existingLines.pop();
}
existingLines.push('');

writeFileSync(envPath, existingLines.join('\n'));

console.log('Dev keys written to .env:');
console.log(`  IDENTITY_PRIVATE_KEY: RSA-2048 PKCS#1 PEM (${privateKey.split('\n').length} lines)`);
console.log(`  IDENTITY_JWKS_KEYS: JWK with kid=dev-1`);
console.log(`  Path: ${envPath}`);

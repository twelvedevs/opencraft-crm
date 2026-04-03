import { generateKeyPairSync, createSign, createPublicKey } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { authPlugin } from '../src/plugin.js';

export function makeKeyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const jwk = {
    ...createPublicKey(publicKey).export({ format: 'jwk' }),
    kid,
    kty: 'RSA' as const,
    use: 'sig',
    alg: 'RS256',
  };
  return { privateKey, publicKey, jwk };
}

export function makeJwt(
  privateKey: string,
  kid: string,
  payload: Record<string, unknown>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const body = Buffer.from(
    JSON.stringify({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
      ...payload,
    }),
  ).toString('base64url');
  const signing = `${header}.${body}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(privateKey, 'base64url');
  return `${signing}.${sig}`;
}

export const JWKS_URL = 'http://test-identity/.well-known/jwks.json';

export async function buildApp(
  keys: object[],
  opts?: { allowedPaths?: string[] },
): Promise<FastifyInstance> {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

  const app = Fastify({ logger: false });
  await app.register(authPlugin, { jwksUrl: JWKS_URL, allowedPaths: opts?.allowedPaths ?? [] });
  return app;
}

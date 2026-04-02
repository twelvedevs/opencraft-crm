import { createVerifier, type VerifierOptions } from 'fast-jwt';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createPublicKey, type KeyObject } from 'node:crypto';

export interface JwtAuthOptions {
  mode: 'static' | 'jwks';
  publicKey?: string;
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
}

interface JwksKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

let jwksCache: { keys: JwksKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchJwks(url: string): Promise<JwksKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${url}: ${res.status}`);
  }
  const data = (await res.json()) as JwksResponse;
  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

function jwksKeyToPublicKey(key: JwksKey): KeyObject {
  const jwk = { kty: key.kty, n: key.n, e: key.e };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

async function jwtAuthPluginImpl(
  fastify: FastifyInstance,
  opts: JwtAuthOptions,
): Promise<void> {
  let verify: (token: string | Buffer) => any;

  const verifierOpts: Partial<VerifierOptions> = {
    algorithms: ['RS256'],
    cache: true,
  };

  if (opts.issuer) {
    verifierOpts.allowedIss = opts.issuer;
  }
  if (opts.audience) {
    verifierOpts.allowedAud = opts.audience;
  }

  if (opts.mode === 'static') {
    if (!opts.publicKey) {
      throw new Error('IDENTITY_SERVICE_PUBLIC_KEY is required when JWT_MODE=static');
    }
    verify = createVerifier({
      ...verifierOpts,
      key: opts.publicKey,
    }) as (token: string | Buffer) => any;
  } else if (opts.mode === 'jwks') {
    if (!opts.jwksUrl) {
      throw new Error('IDENTITY_SERVICE_JWKS_URL is required when JWT_MODE=jwks');
    }
    const jwksUrl = opts.jwksUrl;
    verify = createVerifier({
      ...verifierOpts,
      key: async (decoded: { header: { kid?: string } }) => {
        const keys = await fetchJwks(jwksUrl);
        const kid = decoded.header.kid;
        const matchingKey = kid
          ? keys.find((k) => k.kid === kid)
          : keys[0];
        if (!matchingKey) {
          throw new Error(`No matching JWKS key found for kid: ${kid}`);
        }
        return jwksKeyToPublicKey(matchingKey).export({ type: 'spki', format: 'pem' }) as string;
      },
    }) as (token: string | Buffer) => any;
  } else {
    throw new Error(`Unknown JWT_MODE: ${opts.mode}`);
  }

  fastify.addHook(
    'preHandler',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      const token = authHeader.slice(7);
      try {
        const payload = await verify(token);
        (request as any).user = payload;
      } catch {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    },
  );
}

export const jwtAuthPlugin = fp(jwtAuthPluginImpl, {
  name: 'jwt-auth',
});

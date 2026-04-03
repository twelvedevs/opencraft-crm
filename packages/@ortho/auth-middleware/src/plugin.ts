import { createPublicKey } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { createDecoder, createVerifier } from 'fast-jwt';

export interface JwtPayload {
  sub: string;
  role: string;
  locations: string[];
  must_change_password: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

export interface AuthPluginOptions {
  jwksUrl: string;
  allowedPaths?: string[];
}

interface JwkKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys: JwkKey[];
}

const MUST_CHANGE_PASSWORD_EXEMPT_PATHS = [
  'PUT /identity/me/password',
  'GET /identity/me',
  'DELETE /identity/session',
];

const decoder = createDecoder({ complete: true });

async function fetchJwksWithRetry(url: string, maxAttempts = 3): Promise<JwksResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`JWKS fetch failed with status ${response.status}`);
      }
      return (await response.json()) as JwksResponse;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const delayMs = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function jwkToPem(jwk: JwkKey): string {
  const publicKey = createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: 'jwk',
  });
  return publicKey.export({ type: 'spki', format: 'pem' }) as string;
}

async function authPluginImpl(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const { jwksUrl, allowedPaths = [] } = opts;

  type Verifier = ReturnType<typeof createVerifier>;
  const keyCache = new Map<string, string>();
  const verifierCache = new Map<string, Verifier>();

  let lastRefetchAt = 0;
  const REFETCH_INTERVAL_MS = 60_000;

  async function loadKeys(): Promise<void> {
    const jwks = await fetchJwksWithRetry(jwksUrl);
    // Rebuild caches from scratch on every fetch so retired keys (removed from JWKS
    // during rotation) are evicted rather than retained indefinitely.
    const newKids = new Set(jwks.keys.map((k) => k.kid));
    for (const kid of keyCache.keys()) {
      if (!newKids.has(kid)) {
        keyCache.delete(kid);
        verifierCache.delete(kid);
      }
    }
    for (const key of jwks.keys) {
      if (!keyCache.has(key.kid)) {
        const pem = jwkToPem(key);
        keyCache.set(key.kid, pem);
        verifierCache.set(
          key.kid,
          createVerifier({ key: pem, algorithms: ['RS256'] }),
        );
      }
    }
  }

  await loadKeys();

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const reqPath = req.url.split('?')[0];
    if (allowedPaths.some((p) => reqPath === p)) {
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    const token = authHeader.slice(7);

    let decoded: { header: { kid?: string }; payload: unknown };
    try {
      decoded = decoder(token) as { header: { kid?: string }; payload: unknown };
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }

    const kid = decoded.header.kid;
    if (!kid) {
      return reply.code(401).send({ error: 'invalid_token' });
    }

    let verifier = verifierCache.get(kid);
    if (!verifier) {
      const now = Date.now();
      if (now - lastRefetchAt > REFETCH_INTERVAL_MS) {
        lastRefetchAt = now;
        try {
          await loadKeys();
        } catch {
          return reply.code(503).send({ error: 'jwks_unavailable' });
        }
        verifier = verifierCache.get(kid);
      }

      if (!verifier) {
        return reply.code(401).send({ error: 'invalid_token' });
      }
    }

    let payload: JwtPayload;
    try {
      payload = verifier(token) as unknown as JwtPayload;
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }

    req.user = payload;

    if (payload.must_change_password === true) {
      const methodPath = `${req.method} ${reqPath}`;
      if (!MUST_CHANGE_PASSWORD_EXEMPT_PATHS.includes(methodPath)) {
        return reply.code(403).send({ error: 'password_change_required' });
      }
    }
  });
}

export const authPlugin = fp(authPluginImpl, {
  name: 'ortho-auth',
  fastify: '5.x',
});

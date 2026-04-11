import { createDecoder, createVerifier } from 'fast-jwt';
import { createPublicKey } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { computeKeyHash, getFromCache, setInCache } from '../lib/api-key-cache.js';

// ---------------------------------------------------------------------------
// Types & declaration merges
// ---------------------------------------------------------------------------
interface JwtClaims {
  sub: string;
  role: string;
  locations: string[];
  must_change_password: boolean;
}

interface ApiKeyContext {
  keyHash: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    authType: 'jwt' | 'api-key' | 'public';
    jwtClaims?: JwtClaims;
    apiKeyContext?: ApiKeyContext;
    /** Headers to inject when forwarding to upstream services */
    authHeaders: Record<string, string>;
  }
  interface FastifyContextConfig {
    /** Set to false on routes that bypass JWT/API-key enforcement (public routes) */
    auth?: boolean;
  }
}

// ---------------------------------------------------------------------------
// JWKS helpers
// ---------------------------------------------------------------------------
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

type Verifier = ReturnType<typeof createVerifier>;

const decoder = createDecoder({ complete: true });

async function fetchJwks(url: string): Promise<JwksResponse> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed: ${response.status}`);
  }
  return response.json() as Promise<JwksResponse>;
}

async function fetchJwksWithRetry(url: string, maxAttempts = 3): Promise<JwksResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchJwks(url);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000);
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
async function authPluginImpl(app: FastifyInstance): Promise<void> {
  const jwksUrl = `${config.IDENTITY_SERVICE_URL}/.well-known/jwks.json`;

  // Per-kid verifier cache (kept warm from last JWKS fetch)
  const keyCache = new Map<string, string>();
  const verifierCache = new Map<string, Verifier>();
  let jwksCachedAt = 0;

  async function loadJwks(): Promise<void> {
    const jwks = await fetchJwksWithRetry(jwksUrl);
    // Evict retired keys
    const newKids = new Set(jwks.keys.map((k) => k.kid));
    for (const kid of keyCache.keys()) {
      if (!newKids.has(kid)) {
        keyCache.delete(kid);
        verifierCache.delete(kid);
      }
    }
    for (const key of jwks.keys) {
      if (!verifierCache.has(key.kid)) {
        const pem = jwkToPem(key);
        keyCache.set(key.kid, pem);
        verifierCache.set(key.kid, createVerifier({ key: pem, algorithms: ['RS256'] }));
      }
    }
    jwksCachedAt = Date.now();
  }

  // Warm JWKS cache at startup
  await loadJwks();

  // In-flight deduplication: all concurrent requests for an unknown kid share one
  // JWKS fetch rather than each spawning their own — prevents thundering herd on
  // key rotation where N concurrent requests would all hit the Identity Service at once.
  let jwksInflight: Promise<void> | null = null;

  async function getVerifier(kid: string): Promise<Verifier | null> {
    if (verifierCache.has(kid)) return verifierCache.get(kid)!;

    // Unknown kid — re-fetch JWKS once; all concurrent callers await the same promise.
    if (!jwksInflight) {
      jwksInflight = loadJwks().finally(() => {
        jwksInflight = null;
      });
    }
    try {
      await jwksInflight;
    } catch {
      return null; // JWKS unreachable — fail closed
    }

    return verifierCache.get(kid) ?? null;
  }

  // ---------------------------------------------------------------------------
  // onRequest hook — auth enforcement
  // ---------------------------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Step 1 — Strip synthetic headers unconditionally
    delete request.headers['x-user-id'];
    delete request.headers['x-user-role'];
    delete request.headers['x-user-locations'];
    delete request.headers['x-api-key-permissions'];

    // Step 2 — Check if route opts out of auth
    const routeConfig = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
    if (routeConfig?.['auth'] === false) {
      request.authType = 'public';
      request.authHeaders = {};
      return;
    }

    const authHeader = request.headers['authorization'];

    // Step 3 — Route to JWT or API key path based on Authorization header shape
    if (authHeader?.startsWith('Bearer ak_')) {
      // ---------------------------------------------------------------------------
      // API key path
      // ---------------------------------------------------------------------------
      const rawKey = authHeader.slice(7); // remove "Bearer "
      const keyHash = computeKeyHash(rawKey);

      let permissions: string[];

      const cached = getFromCache(keyHash);
      if (cached) {
        permissions = cached.permissions;
      } else {
        // Call Identity Service to validate
        let idResponse: Response;
        try {
          idResponse = await fetch(`${config.IDENTITY_SERVICE_URL}/identity/api-keys/validate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Secret': config.INTERNAL_API_SECRET,
            },
            body: JSON.stringify({ key: rawKey }),
          });
        } catch {
          // Network error / unreachable → fail closed
          return reply.code(503).send({ error: 'auth_unavailable' });
        }

        if (idResponse.status === 401) {
          return reply.code(401).send({ error: 'unauthorized' });
        }

        if (idResponse.status >= 500 || !idResponse.ok) {
          return reply.code(503).send({ error: 'auth_unavailable' });
        }

        const body = (await idResponse.json()) as { permissions?: string[] };
        permissions = body.permissions ?? [];
        setInCache(keyHash, { permissions });
      }

      request.authType = 'api-key';
      request.apiKeyContext = { keyHash, permissions };
      request.authHeaders = {
        'X-Api-Key-Permissions': permissions.join(','),
      };
      return;
    }

    if (authHeader?.startsWith('Bearer ')) {
      // ---------------------------------------------------------------------------
      // JWT path
      // ---------------------------------------------------------------------------
      const token = authHeader.slice(7);

      let decoded: { header: { kid?: string }; payload: unknown };
      try {
        decoded = decoder(token) as { header: { kid?: string }; payload: unknown };
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const kid = decoded.header.kid;
      if (!kid) return reply.code(401).send({ error: 'unauthorized' });

      const verifier = await getVerifier(kid);
      if (!verifier) return reply.code(401).send({ error: 'unauthorized' });

      let claims: JwtClaims;
      try {
        claims = verifier(token) as unknown as JwtClaims;
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      // must_change_password blocks ALL routes unconditionally
      if (claims.must_change_password === true) {
        return reply.code(403).send({ error: 'password_change_required' });
      }

      request.authType = 'jwt';
      request.jwtClaims = claims;

      // Build forwarding headers; omit X-User-Locations if array is empty
      const authHeaders: Record<string, string> = {
        'X-User-Id': claims.sub,
        'X-User-Role': claims.role,
        Authorization: authHeader,
      };
      if (claims.locations.length > 0) {
        authHeaders['X-User-Locations'] = claims.locations.join(',');
      }
      request.authHeaders = authHeaders;
      return;
    }

    // Step 4 — No Authorization header on a non-public route
    return reply.code(401).send({ error: 'unauthorized' });
  });
}

export default fp(authPluginImpl, {
  name: 'gateway-auth',
  fastify: '5.x',
});

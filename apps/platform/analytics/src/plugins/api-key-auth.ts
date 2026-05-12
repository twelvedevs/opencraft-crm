import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

interface CacheEntry {
  role: string;
  permissions: string;
  expiresAt: number;
}

interface ValidateResponse {
  role: string;
  permissions: string;
}

// In-memory TTL cache keyed by SHA256(api_key). No Redis needed.
const keyCache = new Map<string, CacheEntry>();

export const apiKeyAuthPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers['authorization'];

    // If Authorization header does not start with 'ak_', pass through.
    if (!authHeader || !authHeader.startsWith('ak_')) {
      return;
    }

    const apiKey = authHeader;
    const hash = createHash('sha256').update(apiKey).digest('hex');
    const now = Date.now();

    // Check cache first
    const cached = keyCache.get(hash);
    if (cached && cached.expiresAt > now) {
      request.headers['x-user-role'] = cached.role;
      request.headers['x-api-key-permissions'] = cached.permissions;
      return;
    }

    // Cache miss — validate with Identity Service
    const identityServiceUrl = process.env['IDENTITY_SERVICE_URL'] ?? '';
    const ttlSeconds = parseInt(process.env['API_KEY_CACHE_TTL_SECONDS'] ?? '60', 10);

    let response: Response;
    try {
      response = await fetch(`${identityServiceUrl}/identity/api-keys/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey }),
      });
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    if (response.status === 401 || response.status === 403 || !response.ok) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const data = (await response.json()) as ValidateResponse;

    // Cache the valid result
    keyCache.set(hash, {
      role: data.role,
      permissions: data.permissions,
      expiresAt: now + ttlSeconds * 1000,
    });

    // Inject headers so downstream auth middleware sees a consistent context
    request.headers['x-user-role'] = data.role;
    request.headers['x-api-key-permissions'] = data.permissions;
  });
});

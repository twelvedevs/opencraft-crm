import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Pool } from 'pg';
import { requireRole } from '@ortho/auth-middleware';
import * as apiKeyService from '../services/api-key.service.js';
import { env } from '../env.js';
import '@ortho/auth-middleware';

const CreateApiKeyBody = Type.Object({
  name: Type.String(),
  permissions: Type.Array(Type.String()),
});

const ValidateApiKeyBody = Type.Object({
  key: Type.String(),
});

const IdParams = Type.Object({
  id: Type.String(),
});

const adminOnly = requireRole(['marketing_manager', 'super_admin']);

async function internalSecretGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = req.headers['x-internal-secret'];
  const expected = env.INTERNAL_API_SECRET;
  const secretBuf = Buffer.from(typeof secret === 'string' ? secret : '');
  const expectedBuf = Buffer.from(expected);
  const match =
    secretBuf.length === expectedBuf.length &&
    timingSafeEqual(secretBuf, expectedBuf);
  if (!match) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
}

export async function apiKeysRoutes(
  app: FastifyInstance,
  opts: { pool: Pool },
): Promise<void> {
  const { pool } = opts;

  // POST /identity/api-keys/validate — internal-only, no JWT required
  app.post('/identity/api-keys/validate', {
    schema: { body: ValidateApiKeyBody, tags: ['API Keys'], summary: 'Validate API key' } as object,
    preHandler: [internalSecretGuard],
  }, async (req, reply) => {
    const body = req.body as { key: string };

    try {
      const result = await apiKeyService.validateApiKey(pool, body.key);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const status = error.statusCode ?? 500;
      return reply.status(status).send({ error: error.message });
    }
  });

  // POST /identity/api-keys — create API key
  app.post('/identity/api-keys', {
    schema: { body: CreateApiKeyBody, tags: ['API Keys'], summary: 'Create API key' } as object,
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const body = req.body as { name: string; permissions: string[] };

    try {
      const result = await apiKeyService.generateApiKey(pool, {
        name: body.name,
        permissions: body.permissions,
        createdBy: req.user!.sub,
      });
      return reply.status(201).send(result);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const status = error.statusCode ?? 500;
      return reply.status(status).send({ error: error.message });
    }
  });

  // GET /identity/api-keys — list API keys
  app.get('/identity/api-keys', {
    schema: { tags: ['API Keys'], summary: 'List API keys' } as object,
    preHandler: [adminOnly],
  }, async (_req, reply) => {
    const keys = await apiKeyService.listApiKeys(pool);
    return reply.status(200).send({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        permissions: k.permissions,
        last_used_at: k.last_used_at,
        status: k.revoked_at ? 'revoked' : 'active',
      })),
    });
  });

  // DELETE /identity/api-keys/:id — revoke API key
  app.delete('/identity/api-keys/:id', {
    schema: { params: IdParams, tags: ['API Keys'], summary: 'Revoke API key' } as object,
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    try {
      await apiKeyService.revokeApiKey(pool, id);
      return reply.status(204).send();
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const status = error.statusCode ?? 500;
      return reply.status(status).send({ error: error.message });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Pool } from 'pg';
import type { AuthProvider } from '../providers/auth-provider.interface.js';
import * as userRepo from '../repositories/user.repo.js';
import * as tokenService from '../services/token.service.js';
import { createHash } from 'node:crypto';
import * as refreshTokenRepo from '../repositories/refresh-token.repo.js';

const PostSessionBody = Type.Object({
  provider_token: Type.String(),
});

const PostRefreshBody = Type.Object({
  refresh_token: Type.String(),
});

const DeleteSessionBody = Type.Object({
  refresh_token: Type.String(),
});

export async function sessionRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; provider: AuthProvider },
): Promise<void> {
  const { pool, provider } = opts;

  // POST /identity/session — exchange provider token for enriched JWT
  app.post('/identity/session', {
    schema: { body: PostSessionBody, tags: ['Session'], summary: 'Create session (login)' } as object,
  }, async (req, reply) => {
    const { provider_token } = req.body as { provider_token: string };

    let providerResult: { providerUserId: string; email: string };
    try {
      providerResult = await provider.verifyToken(provider_token);
    } catch {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    const user = await userRepo.findByEmail(pool, providerResult.email);
    if (!user) {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    if (user.status === 'inactive') {
      return reply.status(403).send({ error: 'account_inactive' });
    }

    const locations = await userRepo.getUserLocations(pool, user.id);

    const accessToken = tokenService.signAccessToken({
      sub: user.id,
      role: user.role,
      locations,
      must_change_password: user.force_password_reset,
    });

    const refreshToken = await tokenService.issueRefreshToken(pool, user.id);

    return reply.status(200).send({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 900,
    });
  });

  // POST /identity/refresh — rotate refresh token and issue new JWT
  app.post('/identity/refresh', {
    schema: { body: PostRefreshBody, tags: ['Session'], summary: 'Refresh access token' } as object,
  }, async (req, reply) => {
    const { refresh_token } = req.body as { refresh_token: string };

    let result: { rawToken: string; userId: string };
    try {
      result = await tokenService.rotateRefreshToken(pool, refresh_token);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const status = error.statusCode ?? 500;
      return reply.status(status).send({ error: error.message });
    }

    const user = await userRepo.findById(pool, result.userId);
    if (!user) {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    const locations = await userRepo.getUserLocations(pool, user.id);

    const accessToken = tokenService.signAccessToken({
      sub: user.id,
      role: user.role,
      locations,
      must_change_password: user.force_password_reset,
    });

    return reply.status(200).send({
      access_token: accessToken,
      refresh_token: result.rawToken,
      expires_in: 900,
    });
  });

  // DELETE /identity/session — revoke a specific refresh token (requires JWT)
  app.delete('/identity/session', {
    schema: { body: DeleteSessionBody, tags: ['Session'], summary: 'Delete session (logout)' } as object,
  }, async (req, reply) => {
    const { refresh_token } = req.body as { refresh_token: string };

    const tokenHash = createHash('sha256').update(refresh_token).digest('hex');
    const row = await refreshTokenRepo.findByHash(pool, tokenHash);

    if (row) {
      await refreshTokenRepo.revokeToken(pool, row.id);
    }

    // Always return 204 (idempotent)
    return reply.status(204).send();
  });
}

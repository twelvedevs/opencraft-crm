import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Pool } from 'pg';
import type { AuthProvider } from '../providers/auth-provider.interface.js';
import * as userService from '../services/user.service.js';
import '@ortho/auth-middleware';

const PutPasswordBody = Type.Object({
  current_password: Type.Optional(Type.String()),
  new_password: Type.String(),
});

export async function meRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; provider: AuthProvider },
): Promise<void> {
  const { pool, provider } = opts;

  // GET /identity/me — current user profile
  app.get('/identity/me', { schema: { tags: ['Me'], summary: 'Get current user profile' } as object }, async (req, reply) => {
    const log = req.log.child({ userId: req.user!.sub });
    const user = await userService.getUser(pool, req.user!.sub);
    log.info('profile fetched');
    return reply.status(200).send({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      locations: user.locations,
      force_password_reset: user.force_password_reset,
      status: user.status,
    });
  });

  // PUT /identity/me/password — change own password
  app.put('/identity/me/password', {
    schema: { body: PutPasswordBody, tags: ['Me'], summary: 'Change own password' } as object,
  }, async (req, reply) => {
    const body = req.body as { current_password?: string; new_password: string };

    try {
      await userService.changeOwnPassword(
        pool,
        provider,
        req.user!.sub,
        { currentPassword: body.current_password, newPassword: body.new_password },
        req.user!.must_change_password,
      );
      return reply.status(200).send({});
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number; details?: string[] };
      const status = error.statusCode ?? 500;
      if (error.details) {
        return reply.status(status).send({ error: error.message, details: error.details });
      }
      return reply.status(status).send({ error: error.message });
    }
  });
}

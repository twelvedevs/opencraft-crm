import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Pool } from 'pg';
import type { AuthProvider } from '../providers/auth-provider.interface.js';
import { requireRole } from '@ortho/auth-middleware';
import * as userService from '../services/user.service.js';
import '@ortho/auth-middleware';

const CreateUserBody = Type.Object({
  email: Type.String(),
  name: Type.String(),
  role: Type.String(),
  password: Type.String(),
  locations: Type.Optional(Type.Array(Type.String())),
});

const UpdateUserBody = Type.Object({
  name: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  locations: Type.Optional(Type.Array(Type.String())),
});

const ResetPasswordBody = Type.Object({
  new_password: Type.String(),
});

const ListUsersQuery = Type.Object({
  role: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ default: 50 })),
  cursor: Type.Optional(Type.String()),
});

const IdParams = Type.Object({
  id: Type.String(),
});

const adminOnly = requireRole(['marketing_manager', 'super_admin']);

export async function usersRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; provider: AuthProvider },
): Promise<void> {
  const { pool, provider } = opts;

  // POST /identity/users — create user
  app.post('/identity/users', {
    schema: { body: CreateUserBody },
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const log = req.log.child({ userId: req.user.sub });
    const body = req.body as { email: string; name: string; role: string; password: string; locations?: string[] };

    try {
      const user = await userService.createUser(pool, provider, {
        email: body.email,
        name: body.name,
        role: body.role,
        password: body.password,
        locations: body.locations,
        created_by: req.user.sub,
      });
      log.info({ targetEmail: body.email }, 'user created');
      return reply.status(201).send({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        locations: user.locations,
        status: user.status,
        force_password_reset: user.force_password_reset,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number; details?: string[] };
      const status = error.statusCode ?? 500;
      if (error.details) {
        return reply.status(status).send({ error: error.message, details: error.details });
      }
      return reply.status(status).send({ error: error.message });
    }
  });

  // GET /identity/users — list users with cursor pagination
  app.get('/identity/users', {
    schema: { querystring: ListUsersQuery },
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const query = req.query as { role?: string; status?: string; limit?: number; cursor?: string };
    const result = await userService.listUsers(pool, {
      role: query.role,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit ?? 50,
    });
    return reply.status(200).send({
      users: result.rows,
      next_cursor: result.nextCursor,
    });
  });

  // GET /identity/users/:id — get user by ID
  app.get('/identity/users/:id', {
    schema: { params: IdParams },
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    try {
      const user = await userService.getUser(pool, id);
      return reply.status(200).send({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        locations: user.locations,
        status: user.status,
        force_password_reset: user.force_password_reset,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const status = error.statusCode ?? 500;
      return reply.status(status).send({ error: error.message });
    }
  });

  // PUT /identity/users/:id — update user
  app.put('/identity/users/:id', {
    schema: { params: IdParams, body: UpdateUserBody },
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; role?: string; status?: string; locations?: string[] };

    try {
      const user = await userService.updateUser(pool, provider, id, body);
      return reply.status(200).send({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        locations: user.locations,
        status: user.status,
        force_password_reset: user.force_password_reset,
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const status = error.statusCode ?? 500;
      return reply.status(status).send({ error: error.message });
    }
  });

  // PUT /identity/users/:id/password — admin reset password
  app.put('/identity/users/:id/password', {
    schema: { params: IdParams, body: ResetPasswordBody },
    preHandler: [adminOnly],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { new_password: string };

    try {
      await userService.adminResetPassword(pool, provider, id, body.new_password);
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

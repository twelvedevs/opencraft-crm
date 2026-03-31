import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from 'fastify';
import jwt from '@fastify/jwt';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
    requireRole(roles: string[]): preHandlerAsyncHookHandler;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const JWT_SECRET = process.env['JWT_SECRET'];
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is required');
  }

  await fastify.register(jwt, { secret: JWT_SECRET });

  fastify.decorate('authenticate', async (request: Parameters<preHandlerAsyncHookHandler>[0], reply: Parameters<preHandlerAsyncHookHandler>[1]) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  fastify.decorate('requireRole', (roles: string[]): preHandlerAsyncHookHandler => {
    return async (request, reply) => {
      const user = request.user as { sub: string; role: string };
      if (!roles.includes(user.role)) {
        throw fastify.httpErrors.forbidden('Insufficient role');
      }
    };
  });
};

export default authPlugin;

import type { preHandlerHookHandler } from 'fastify';

export function requireRole(allowedRoles: string[]): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

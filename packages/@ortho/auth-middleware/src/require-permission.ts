import type { preHandlerHookHandler } from 'fastify';
import { ROLE_PERMISSIONS } from './permissions.js';

export function requirePermission(permission: string): preHandlerHookHandler {
  return async (req, reply) => {
    if (req.user?.role === 'super_admin') return;
    const perms = ROLE_PERMISSIONS[req.user?.role ?? ''] ?? [];
    if (!perms.includes(permission)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

import type { preHandlerHookHandler } from 'fastify';

const LOCATION_BYPASS_ROLES = ['marketing_staff', 'marketing_manager', 'super_admin'];

export function requireLocation(): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.user) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (LOCATION_BYPASS_ROLES.includes(req.user.role)) {
      return;
    }

    const locationId =
      (req.params as Record<string, string>)?.['location_id'] ??
      (req.query as Record<string, string>)?.['location_id'];

    if (!locationId) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    if (!req.user?.locations?.includes(locationId)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

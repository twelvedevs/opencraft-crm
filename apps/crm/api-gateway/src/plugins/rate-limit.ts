import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Plugin — tiered rate limiting by auth type
// Auth plugin runs in onRequest before this preHandler phase, so authType
// is already populated when keyGenerator and max are called.
// ---------------------------------------------------------------------------
async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    // Skip routes flagged with config.skipRateLimit (e.g. /health)
    allowList: (request: FastifyRequest) => {
      const routeConfig = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
      return routeConfig?.['skipRateLimit'] === true;
    },
    keyGenerator: (request: FastifyRequest) => {
      if (request.authType === 'jwt' && request.jwtClaims) {
        return `jwt:${request.jwtClaims.sub}`;
      }

      if (request.authType === 'api-key' && request.apiKeyContext) {
        return `ak:${request.apiKeyContext.keyHash}`;
      }

      // Public / unauthenticated — key by rightmost X-Forwarded-For IP (added by ALB)
      const forwarded = request.headers['x-forwarded-for'];
      if (forwarded) {
        const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
        return `ip:${ips[ips.length - 1].trim()}`;
      }

      return `ip:${request.ip}`;
    },
    max: (request: FastifyRequest) => {
      if (request.authType === 'jwt') return 300;
      if (request.authType === 'api-key') return 600;
      return 60; // public / unauthenticated
    },
    timeWindow: 60_000, // 1 minute
    errorResponseBuilder: (_request, _context) => ({
      error: 'rate_limit_exceeded',
    }),
  });
}

export default fp(rateLimitPlugin, {
  name: 'gateway-rate-limit',
  fastify: '5.x',
});

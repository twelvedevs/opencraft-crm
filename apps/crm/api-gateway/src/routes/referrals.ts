import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/referrals/*
// Public routes: /r/:code (click redirect), /links/:code, /portal/:token
// All other routes require JWT auth.
//
// Note on /r/:code redirect behaviour: the global @fastify/reply-from
// registration sets undici maxRedirections:0, so upstream 302 responses are
// returned to the browser as-is. This preserves click-tracking intent (spec §3.1).
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

// Shared handler for all three public referral routes — no auth headers injected.
async function publicReferralHandler(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const upstreamPath = request.url.replace(/^\/v1/, '');
  return reply.from(`${config.REFERRAL_SERVICE_URL}${upstreamPath}`, {
    rewriteRequestHeaders: (_req, headers) => ({
      ...headers,
      'x-request-id': request.requestId,
    }),
  });
}

async function referralsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Public — GET /referrals/r/:code, /referrals/links/:code, /referrals/portal/:token
  // No JWT check. 302 from /r/:code is returned as-is (maxRedirections:0 globally).
  // -------------------------------------------------------------------------
  for (const url of ['/r/:code', '/links/:code', '/portal/:token']) {
    app.route({
      method: 'GET',
      url,
      config: { auth: false },
      handler: publicReferralHandler,
    });
  }

  // -------------------------------------------------------------------------
  // All other /referrals/* routes — JWT auth required (enforced by auth plugin)
  // -------------------------------------------------------------------------
  app.route({
    method: HTTP_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.REFERRAL_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default referralsRoutes;

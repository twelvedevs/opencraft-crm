import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/referrals/*
// Public routes: /r/:code (click redirect), /links/:code, /portal/:token
// All other routes require JWT auth.
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function referralsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Public — GET /referrals/r/:code (click redirect, followRedirects: false)
  // -------------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/r/:code',
    config: { auth: false },
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.REFERRAL_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // -------------------------------------------------------------------------
  // Public — GET /referrals/links/:code
  // -------------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/links/:code',
    config: { auth: false },
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.REFERRAL_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // -------------------------------------------------------------------------
  // Public — GET /referrals/portal/:token
  // -------------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/portal/:token',
    config: { auth: false },
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.REFERRAL_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

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

export default fp(referralsRoutes, {
  name: 'referrals-routes',
  fastify: '5.x',
});

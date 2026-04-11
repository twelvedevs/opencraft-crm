import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { resolveChannel } from '../lib/channel-resolver.js';

// ---------------------------------------------------------------------------
// Route — /v1/pipeline/* proxy to Pipeline Service
// Special handling:
//  - POST /v1/pipeline/transitions: RBAC check when body.override === true
//  - POST /v1/pipeline/convert: channel enrichment from Lead Service
// ---------------------------------------------------------------------------

const OVERRIDE_PERMITTED_ROLES = new Set([
  'call_center_manager',
  'marketing_manager',
  'super_admin',
]);

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // POST /pipeline/transitions — override RBAC
  // ---------------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/transitions',
    handler: async (request, reply) => {
      const body = request.body as Record<string, unknown> | null | undefined;

      // RBAC applies only to JWT callers when override === true
      if (
        request.authType === 'jwt' &&
        body !== null &&
        body !== undefined &&
        body['override'] === true
      ) {
        const role = request.jwtClaims?.role ?? '';
        if (!OVERRIDE_PERMITTED_ROLES.has(role)) {
          return reply.code(403).send({ error: 'forbidden' });
        }
      }

      return reply.from(`${config.PIPELINE_SERVICE_URL}/pipeline/transitions`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // POST /pipeline/convert — channel enrichment
  // ---------------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/convert',
    handler: async (request, reply) => {
      const body = request.body as Record<string, unknown> | null | undefined;
      const leadId = body?.['lead_id'];

      if (!leadId || typeof leadId !== 'string') {
        return reply.code(422).send({ error: 'channel_resolution_failed' });
      }

      const result = await resolveChannel(leadId);

      if (!result.ok) {
        switch (result.error) {
          case 'lead_not_found':
            return reply.code(404).send({ error: 'lead_not_found' });
          case 'upstream_unavailable':
            return reply.code(502).send({ error: 'upstream_unavailable' });
          case 'channel_resolution_failed':
            return reply.code(422).send({ error: 'channel_resolution_failed' });
        }
      }

      // Overwrite channel in the body with the gateway-resolved value
      const enrichedBody = { ...body, channel: result.channel };

      return reply.from(`${config.PIPELINE_SERVICE_URL}/pipeline/convert`, {
        body: enrichedBody,
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // All other /pipeline/* routes — simple pass-through
  // ---------------------------------------------------------------------------
  app.route({
    method: HTTP_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.PIPELINE_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default pipelineRoutes;

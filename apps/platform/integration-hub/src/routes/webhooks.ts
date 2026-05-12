import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { getConnector } from '../connectors/registry.js';
import * as failedWebhooksRepo from '../repositories/failed-webhooks.js';

export interface WebhookRoutesOpts {
  pool: Pool;
  leadWebhookQueue: Queue;
}

export async function webhookRoutes(
  fastify: FastifyInstance,
  opts: WebhookRoutesOpts,
): Promise<void> {
  const { pool, leadWebhookQueue } = opts;

  // Register raw body content type parser so we can access the raw Buffer
  // for signature verification. This replaces the default JSON parser within
  // this plugin scope.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // POST /integrations/webhooks/:platform
  fastify.post<{ Params: { platform: string } }>(
    '/integrations/webhooks/:platform',
    { schema: { tags: ['Webhooks'], summary: 'Receive ad platform webhook' } as object },
    async (request, reply) => {
      const { platform } = request.params;

      const connector = getConnector(platform);

      const rawBody = request.body as Buffer;
      const headers = request.headers as Record<string, string>;

      const valid = connector.verifyWebhook(headers, rawBody);
      if (!valid) {
        return reply.code(403).send({ error: 'Invalid webhook signature' });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        return reply.code(400).send({ error: 'Invalid JSON body' });
      }

      let leadEvents;
      try {
        leadEvents = connector.parseLeadWebhook(parsed);
      } catch (err) {
        // Parse error — log, store to failed_webhooks, still return 200
        const client = await pool.connect();
        try {
          await failedWebhooksRepo.insert(client, {
            platform,
            raw_body: rawBody.toString('utf-8'),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          client.release();
        }
        request.log.warn({ platform, err }, 'Failed to parse lead webhook');
        return reply.code(200).send({ status: 'accepted' });
      }

      // Enqueue a process-lead-webhook job per lead event
      for (const leadEvent of leadEvents) {
        await leadWebhookQueue.add(
          'process-lead-webhook',
          { platform, leadEvent },
          { jobId: `${platform}:${leadEvent.external_lead_id}` },
        );
      }

      return reply.code(200).send({ status: 'accepted' });
    },
  );

  // GET /integrations/webhooks/:platform/verify
  fastify.get<{ Params: { platform: string }; Querystring: Record<string, string> }>(
    '/integrations/webhooks/:platform/verify',
    { schema: { tags: ['Webhooks'], summary: 'Verify ad platform webhook' } as object },
    async (request, reply) => {
      const { platform } = request.params;

      const connector = getConnector(platform);

      const challenge = connector.verifyChallenge(
        request.query as Record<string, string>,
      );
      if (challenge === null) {
        return reply.code(403).send({ error: 'Invalid verify token' });
      }

      return reply.code(200).send(challenge);
    },
  );
}

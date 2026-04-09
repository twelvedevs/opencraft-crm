import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import * as sendsRepo from '../repositories/campaign-sends.repo.js';
import * as conversionsRepo from '../repositories/campaign-conversions.repo.js';
import * as eventsRepo from '../repositories/campaign-events.repo.js';
import { env } from '../env.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const PaginationQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ default: 100 })),
  offset: Type.Optional(Type.Integer({ default: 0 })),
});

const TestSendBody = Type.Object({
  to_email: Type.String(),
  context: Type.Optional(Type.Object({})),
});

const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

const writePerm = requirePermission('campaigns:write');

export async function diagnosticsRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /campaigns/:id/sends
  app.get('/:id/sends', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const sends = await sendsRepo.findAllByCampaignId(db, id);

    return reply.status(200).send({
      sends: sends.map((s) => ({
        id: s.id,
        location_id: s.location_id,
        variant: s.variant,
        subject_used: s.subject_used,
        status: s.status,
        total_recipients: s.total_recipients,
        sent_count: s.sent_count,
        failed_count: s.failed_count,
        completed_at: s.completed_at,
      })),
    });
  });

  // GET /campaigns/:id/conversions
  app.get('/:id/conversions', {
    schema: { params: IdParams, querystring: PaginationQuery },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: number; offset?: number };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const result = await conversionsRepo.listByCampaignId(db, id, {
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
    });

    return reply.status(200).send(result);
  });

  // GET /campaigns/:id/events
  app.get('/:id/events', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const events = await eventsRepo.listByCampaignId(db, id);

    return reply.status(200).send({
      events: events.map((e) => ({
        from_status: e.from_status,
        to_status: e.to_status,
        actor_id: e.actor_id,
        comment: e.comment,
        created_at: e.created_at,
      })),
    });
  });

  // POST /campaigns/:id/test-send
  app.post('/:id/test-send', {
    schema: { params: IdParams, body: TestSendBody },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { to_email: string; context?: Record<string, unknown> };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    if (TERMINAL_STATUSES.includes(campaign.status)) {
      return reply.status(409).send({ error: `Cannot test-send a campaign with status '${campaign.status}'` });
    }

    // Render template
    const renderRes = await fetch(`${env.TEMPLATE_SERVICE_URL}/templates/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: campaign.template_id,
        context: body.context ?? {},
      }),
    });

    if (!renderRes.ok) {
      const err = await renderRes.text();
      return reply.status(502).send({ error: `Template render failed: ${err}` });
    }

    const rendered = (await renderRes.json()) as { html: string; subject?: string };

    // Send email
    const sendRes = await fetch(`${env.EMAIL_SERVICE_URL}/emails/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: body.to_email,
        subject: campaign.subject ?? rendered.subject ?? campaign.name,
        html: rendered.html,
      }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      return reply.status(502).send({ error: `Email send failed: ${err}` });
    }

    return reply.status(200).send({ message: 'Test email sent' });
  });

  // POST /campaigns/:id/spam-check
  app.post('/:id/spam-check', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    if (TERMINAL_STATUSES.includes(campaign.status)) {
      return reply.status(409).send({ error: `Cannot spam-check a campaign with status '${campaign.status}'` });
    }

    // Render template sample
    const renderRes = await fetch(`${env.TEMPLATE_SERVICE_URL}/templates/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: campaign.template_id,
        context: {},
      }),
    });

    if (!renderRes.ok) {
      const err = await renderRes.text();
      return reply.status(502).send({ error: `Template render failed: ${err}` });
    }

    const rendered = (await renderRes.json()) as { html: string; subject?: string };

    // Spam check
    const checkRes = await fetch(`${env.EMAIL_SERVICE_URL}/emails/spam-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: rendered.html,
        subject: campaign.subject ?? rendered.subject ?? campaign.name,
      }),
    });

    if (!checkRes.ok) {
      const err = await checkRes.text();
      return reply.status(502).send({ error: `Spam check failed: ${err}` });
    }

    const result = (await checkRes.json()) as {
      score: number;
      threshold: number;
      passed: boolean;
      issues: string[];
    };

    return reply.status(200).send(result);
  });
}

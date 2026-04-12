import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import * as campaignEventsRepo from '../repositories/campaign-events.repo.js';
import { validateContentLock } from '../services/campaign-service.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const CreateCampaignBody = Type.Object({
  name: Type.String(),
  template_id: Type.String(),
  subject: Type.Optional(Type.String()),
  segment_id: Type.Optional(Type.String()),
  audience_filter: Type.Optional(Type.Object({})),
  ab_test: Type.Optional(
    Type.Object({
      enabled: Type.Boolean(),
      mode: Type.Union([Type.Literal('holdout'), Type.Literal('full_split')]),
      variant_a_subject: Type.String(),
      variant_b_subject: Type.String(),
      test_split_pct: Type.Optional(Type.Number()),
      winner_delay_hours: Type.Optional(Type.Number()),
    }),
  ),
});

const PatchCampaignBody = Type.Object({
  name: Type.Optional(Type.String()),
  template_id: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  segment_id: Type.Optional(Type.String()),
  audience_filter: Type.Optional(Type.Object({})),
  scheduled_for: Type.Optional(Type.String()),
  ab_enabled: Type.Optional(Type.Boolean()),
  ab_mode: Type.Optional(Type.String()),
  ab_test_split_pct: Type.Optional(Type.Number()),
  ab_variant_a_subject: Type.Optional(Type.String()),
  ab_variant_b_subject: Type.Optional(Type.String()),
});

const ListCampaignsQuery = Type.Object({
  status: Type.Optional(Type.String()),
  created_by: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ default: 20 })),
  offset: Type.Optional(Type.Integer({ default: 0 })),
});

const writePerm = requirePermission('campaigns:write');

export async function campaignsRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /campaigns — create draft
  app.post('/', {
    schema: { body: CreateCampaignBody, tags: ['Campaigns'], summary: 'Create campaign' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const body = req.body as {
      name: string;
      template_id: string;
      subject?: string;
      segment_id?: string;
      audience_filter?: Record<string, unknown>;
      ab_test?: {
        enabled: boolean;
        mode: 'holdout' | 'full_split';
        variant_a_subject: string;
        variant_b_subject: string;
        test_split_pct?: number;
        winner_delay_hours?: number;
      };
    };

    // Validate exactly one of segment_id or audience_filter
    const hasSegment = body.segment_id !== undefined;
    const hasFilter = body.audience_filter !== undefined;
    if ((hasSegment && hasFilter) || (!hasSegment && !hasFilter)) {
      return reply.status(400).send({
        error: 'Exactly one of segment_id or audience_filter must be provided',
      });
    }

    const createData: Parameters<typeof campaignsRepo.create>[1] = {
      name: body.name,
      template_id: body.template_id,
      subject: body.subject ?? null,
      segment_id: body.segment_id ?? null,
      audience_filter: body.audience_filter ?? null,
      created_by: req.user!.sub,
    };

    if (body.ab_test) {
      createData.ab_enabled = body.ab_test.enabled;
      createData.ab_mode = body.ab_test.mode;
      createData.ab_variant_a_subject = body.ab_test.variant_a_subject;
      createData.ab_variant_b_subject = body.ab_test.variant_b_subject;
      if (body.ab_test.test_split_pct !== undefined) {
        createData.ab_test_split_pct = body.ab_test.test_split_pct;
      }
      if (body.ab_test.winner_delay_hours !== undefined) {
        createData.ab_winner_delay_hours = body.ab_test.winner_delay_hours;
      }
    }

    const campaign = await campaignsRepo.create(db, createData);

    await campaignEventsRepo.insertEvent(db, {
      campaign_id: campaign.id,
      from_status: null,
      to_status: 'draft',
      actor_id: req.user!.sub,
    });

    return reply.status(201).send({
      campaign_id: campaign.id,
      status: campaign.status,
    });
  });

  // GET /campaigns — list with filters
  app.get('/', {
    schema: { querystring: ListCampaignsQuery, tags: ['Campaigns'], summary: 'List campaigns' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const query = req.query as {
      status?: string;
      created_by?: string;
      limit?: number;
      offset?: number;
    };

    const statusFilter = query.status
      ? query.status.split(',').map((s) => s.trim())
      : undefined;

    const result = await campaignsRepo.list(db, {
      status: statusFilter,
      created_by: query.created_by,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });

    return reply.status(200).send(result);
  });

  // GET /campaigns/:id — get by ID
  app.get('/:id', {
    schema: { params: IdParams, tags: ['Campaigns'], summary: 'Get campaign by ID' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    return reply.status(200).send(campaign);
  });

  // PATCH /campaigns/:id — update fields
  app.patch('/:id', {
    schema: { params: IdParams, body: PatchCampaignBody, tags: ['Campaigns'], summary: 'Update campaign' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    // Check content lock
    const patchFields = Object.keys(body);
    const lockCheck = validateContentLock(campaign.status, patchFields);
    if (!lockCheck.ok) {
      return reply.status(409).send({ error: lockCheck.error });
    }

    const updated = await campaignsRepo.update(db, id, body as Parameters<typeof campaignsRepo.update>[2]);

    return reply.status(200).send({
      campaign_id: updated.id,
      status: updated.status,
      updated_at: updated.updated_at,
    });
  });

  // DELETE /campaigns/:id — only draft campaigns
  app.delete('/:id', {
    schema: { params: IdParams, tags: ['Campaigns'], summary: 'Delete campaign' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    if (campaign.status !== 'draft') {
      return reply.status(409).send({
        error: `Cannot delete campaign with status '${campaign.status}'. Only draft campaigns can be deleted.`,
      });
    }

    await campaignsRepo.remove(db, id);

    return reply.status(200).send({ campaign_id: id, deleted: true });
  });
}

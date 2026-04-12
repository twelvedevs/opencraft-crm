import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { Type } from '@sinclair/typebox';
import '@ortho/auth-middleware';
import * as leadRepository from '../repositories/lead-repository.js';
import * as activityRepository from '../repositories/activity-repository.js';
import { env } from '../env.js';

const LeadIdParams = Type.Object({
  id: Type.String(),
});

const ActivitiesQuery = Type.Object({
  event_type: Type.Optional(Type.Array(Type.String())),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ default: 50, maximum: 200 })),
});

export async function activityRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db } = opts;

  // GET /leads/:id/activities
  app.get('/leads/:id/activities', {
    schema: { params: LeadIdParams, querystring: ActivitiesQuery, tags: ['Activities'], summary: 'List lead activity timeline' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as {
      event_type?: string[];
      cursor?: string;
      limit?: number;
    };

    const lead = await leadRepository.findById(db, id);
    if (!lead) {
      return reply.status(404).send({ error: 'not found' });
    }

    const result = await activityRepository.listActivities(db, id, {
      eventTypes: query.event_type,
      cursor: query.cursor,
      limit: query.limit,
    });

    return reply.status(200).send(result);
  });

  // GET /leads/:id/score-commentary
  app.get('/leads/:id/score-commentary', {
    schema: { params: LeadIdParams, tags: ['Activities'], summary: 'Get AI score commentary' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const lead = await leadRepository.findById(db, id);
    if (!lead) {
      return reply.status(404).send({ error: 'not found' });
    }

    try {
      const response = await fetch(env.AI_SERVICE_URL + '/ai/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SERVICE_AUTH_TOKEN}`,
        },
        body: JSON.stringify({
          prompt_id: 'lead_score_commentary',
          context: {
            lead_id: id,
            score: lead.score,
            current_pipeline: lead.current_pipeline,
            current_stage: lead.current_stage,
            contact_status: lead.contact_status,
            channel: lead.channel,
          },
        }),
      });

      if (!response.ok) {
        return reply.status(503).send({ error: 'AI service unavailable' });
      }

      const data = await response.json() as { commentary: string };
      return reply.status(200).send({ score: lead.score, commentary: data.commentary });
    } catch {
      return reply.status(503).send({ error: 'AI service unavailable' });
    }
  });
}

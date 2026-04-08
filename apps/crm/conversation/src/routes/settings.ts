import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as settingsRepo from '../repositories/settings.repo.js';

const LocationIdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const PatchSettingsBody = Type.Object({
  inactivity_days: Type.Optional(Type.Integer({ minimum: 1 })),
  agent_mode_enabled: Type.Optional(Type.Boolean()),
  agent_max_exchanges: Type.Optional(Type.Integer({ minimum: 1 })),
  location_phone: Type.Optional(Type.String()),
  practice_number: Type.Optional(Type.String()),
});

const SETTINGS_ROLES = ['marketing_manager', 'super_admin'];

export async function settingsRoute(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /conversations/settings/locations/:id
  app.get('/settings/locations/:id', { schema: { params: LocationIdParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };

    if (!req.user || !SETTINGS_ROLES.includes(req.user.role)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const settings = await settingsRepo.findByLocationId(db, id);
    if (!settings) {
      return reply.status(404).send({ error: 'not_found' });
    }

    return reply.send(settings);
  });

  // PATCH /conversations/settings/locations/:id
  app.patch('/settings/locations/:id', { schema: { params: LocationIdParams, body: PatchSettingsBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      inactivity_days?: number;
      agent_mode_enabled?: boolean;
      agent_max_exchanges?: number;
      location_phone?: string;
      practice_number?: string;
    };

    if (!req.user || !SETTINGS_ROLES.includes(req.user.role)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    // Validate agent_mode_enabled constraints
    if (body.agent_mode_enabled === true) {
      const existing = await settingsRepo.findByLocationId(db, id);
      const effectivePhone = body.location_phone ?? existing?.location_phone;
      const effectivePractice = body.practice_number ?? existing?.practice_number;

      if (!effectivePhone) {
        return reply.status(422).send({ error: 'unprocessable', reason: 'location_phone is required when enabling agent mode' });
      }
      if (!effectivePractice) {
        return reply.status(422).send({ error: 'unprocessable', reason: 'practice_number is required when enabling agent mode' });
      }
    }

    const updated = await settingsRepo.upsert(db, id, body);
    return reply.send(updated);
  });
}

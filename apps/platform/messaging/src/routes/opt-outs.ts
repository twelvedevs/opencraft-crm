import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { OptOutsRepository, OptOutSchema } from '../repositories/opt-outs.repo.js';
import { OptOutRegistry } from '../services/opt-out-registry.js';

export async function optOutRoutes(app: FastifyInstance): Promise<void> {
  const repo = new OptOutsRepository(app.db);
  const registry = new OptOutRegistry(repo);

  // GET /opt-outs/:phone
  app.get('/opt-outs/:phone', {
    schema: {
      tags: ['Opt-outs'],
      summary: 'Check opt-out status for phone',
      params: Type.Object({ phone: Type.String() }),
    } as object,
  }, async (request, reply) => {
    const { phone } = request.params as { phone: string };
    const record = await repo.findByPhone(phone);
    if (record) {
      return reply.send({ opted_out: true, opted_out_at: record.opted_out_at, source: record.source });
    }
    return reply.send({ opted_out: false });
  });

  // POST /opt-outs
  app.post('/opt-outs', {
    schema: {
      tags: ['Opt-outs'],
      summary: 'Add opt-out',
      body: Type.Object({
        phone_number: Type.String(),
        source: Type.Optional(Type.String()),
      }),
      response: { 201: OptOutSchema },
    } as object,
  }, async (request, reply) => {
    const { phone_number, source } = request.body as { phone_number: string; source?: string };
    await registry.register(phone_number, source ?? 'admin');
    const record = await repo.findByPhone(phone_number);
    return reply.status(201).send(record!);
  });

  // DELETE /opt-outs/:phone
  app.delete('/opt-outs/:phone', {
    schema: {
      tags: ['Opt-outs'],
      summary: 'Remove opt-out',
      params: Type.Object({ phone: Type.String() }),
    } as object,
  }, async (request, reply) => {
    const { phone } = request.params as { phone: string };
    const removed = await registry.remove(phone);
    if (!removed) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.status(204).send();
  });
}

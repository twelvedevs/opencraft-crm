import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { NumbersRepository, NumberSchema } from '../repositories/numbers.repo.js';

export async function numberRoutes(app: FastifyInstance): Promise<void> {
  const repo = new NumbersRepository(app.db);

  const CreateBodySchema = Type.Object({
    location_id: Type.String(),
    channel: Type.String(),
    phone_number: Type.String(),
    friendly_name: Type.Optional(Type.String()),
    rate_limit_mps: Type.Optional(Type.Integer()),
  });

  const IdParamsSchema = Type.Object({ id: Type.String() });
  const ErrorSchema = Type.Object({ error: Type.String() });

  // POST /numbers
  app.post('/numbers', {
    schema: {
      body: CreateBodySchema,
      response: { 201: NumberSchema, 409: ErrorSchema },
    },
  }, async (request, reply) => {
    const body = request.body as {
      location_id: string;
      channel: string;
      phone_number: string;
      friendly_name?: string;
      rate_limit_mps?: number;
    };
    try {
      const number = await repo.create(body);
      return reply.status(201).send(number);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return reply.status(409).send({ error: 'duplicate_number' });
      }
      throw err;
    }
  });

  // DELETE /numbers/:id
  app.delete('/numbers/:id', {
    schema: {
      params: IdParamsSchema,
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const number = await repo.findById(id);
    if (!number) {
      return reply.status(404).send({ error: 'not_found' });
    }
    await repo.delete(id);
    return reply.status(204).send();
  });

  // GET /numbers
  app.get('/numbers', {
    schema: {
      response: { 200: Type.Array(NumberSchema) },
    },
  }, async (request, reply) => {
    const query = request.query as {
      location_id?: string;
      channel?: string;
      active?: string;
    };
    const filters: { location_id?: string; channel?: string; active?: boolean } = {};
    if (query.location_id) filters.location_id = query.location_id;
    if (query.channel) filters.channel = query.channel;
    if (query.active !== undefined) filters.active = query.active === 'true';
    const numbers = await repo.findAll(filters);
    return reply.send(numbers);
  });

  // GET /numbers/resolve
  app.get('/numbers/resolve', {
    schema: {
      querystring: Type.Object({
        location_id: Type.String(),
        channel: Type.String(),
      }),
      response: {
        200: Type.Object({ phone_number: Type.String() }),
        422: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const { location_id, channel } = request.query as {
      location_id: string;
      channel: string;
    };
    const number = await repo.findByLocationAndChannel(location_id, channel);
    if (!number) {
      return reply.status(422).send({ error: 'number_not_found' });
    }
    return reply.send({ phone_number: number.phone_number });
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23505'
  );
}

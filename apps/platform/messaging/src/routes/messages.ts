import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { MessagesRepository, MessageSchema } from '../repositories/messages.repo.js';
import { NumbersRepository } from '../repositories/numbers.repo.js';
import { OptOutsRepository } from '../repositories/opt-outs.repo.js';
import { OptOutRegistry } from '../services/opt-out-registry.js';
import { NumberResolver, NumberNotFoundError } from '../services/number-resolver.js';
import { SendMessageService } from '../services/send-message.js';
import type { RateLimiter } from '../services/rate-limiter.js';

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const messagesRepo = new MessagesRepository(app.db);
  const numbersRepo = new NumbersRepository(app.db);
  const optOutsRepo = new OptOutsRepository(app.db);
  const optOutRegistry = new OptOutRegistry(optOutsRepo);
  const numberResolver = new NumberResolver(numbersRepo);

  const SendBodySchema = Type.Object({
    to: Type.String(),
    from_number: Type.Optional(Type.String()),
    location_id: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    template: Type.Optional(Type.String()),
    context: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String()),
    media_url: Type.Optional(Type.String()),
    dedup_key: Type.Optional(Type.String()),
  });

  const ErrorSchema = Type.Object({ error: Type.String() });

  // POST /messages/send
  app.post('/messages/send', {
    schema: {
      tags: ['Messages'],
      summary: 'Send SMS message',
      body: SendBodySchema,
    } as object,
  }, async (request, reply) => {
    const body = request.body as {
      to: string;
      from_number?: string;
      location_id?: string;
      channel?: string;
      template?: string;
      context?: Record<string, string>;
      body?: string;
      media_url?: string;
      dedup_key?: string;
    };

    const service = new SendMessageService(
      optOutRegistry,
      messagesRepo,
      numberResolver,
      app.rateLimiter,
      app.twilioClient,
      app.statusCallbackUrl,
    );

    const result = await service.send(body);

    switch (result.status) {
      case 'queued':
        return reply.status(200).send({ status: 'queued', message_id: result.message_id });
      case 'duplicate':
        return reply.status(200).send({ status: 'duplicate', message_id: result.message_id });
      case 'opted_out':
        return reply.status(400).send({ error: 'opted_out' });
      case 'number_not_found':
        return reply.status(422).send({ error: result.error });
      case 'throttled':
        reply.header('Retry-After', String(result.retryAfter));
        return reply.status(429).send({ error: 'throttled', retryAfter: result.retryAfter });
      case 'twilio_error':
        return reply.status(502).send({ error: result.error });
      case 'validation_error':
        return reply.status(400).send({ error: result.error });
    }
  });

  // GET /messages/:id
  app.get('/messages/:id', {
    schema: {
      tags: ['Messages'],
      summary: 'Get message by ID',
      params: Type.Object({ id: Type.String() }),
    } as object,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const message = await messagesRepo.findById(id);
    if (!message) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(message);
  });

  // GET /messages
  app.get('/messages', { schema: { tags: ['Messages'], summary: 'List messages' } as object }, async (request, reply) => {
    const query = request.query as {
      to?: string;
      from_number?: string;
      status?: string;
      from_date?: string;
      to_date?: string;
      cursor?: string;
      limit?: string;
    };

    const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 100);

    const result = await messagesRepo.list(
      {
        to_number: query.to,
        from_number: query.from_number,
        status: query.status,
        from_date: query.from_date,
        to_date: query.to_date,
      },
      query.cursor,
      limit,
    );

    return reply.send({ data: result.data, nextCursor: result.next_cursor });
  });
}

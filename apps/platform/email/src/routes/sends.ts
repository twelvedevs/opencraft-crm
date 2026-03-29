import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { DomainRepository } from '../repositories/domain-repository.js';
import { DomainResolver } from '../services/domain-resolver.js';
import { EmailSendsRepository } from '../repositories/email-sends-repository.js';
import { DomainNotConfiguredError, DomainNotVerifiedError } from '../errors.js';

const SendEmailBodySchema = Type.Object({
  dedup_key: Type.String(),
  location_id: Type.String(),
  to: Type.String(),
  subject: Type.String(),
  html: Type.String(),
  text: Type.String(),
  entity_type: Type.Optional(Type.String()),
  entity_id: Type.Optional(Type.String()),
});

export async function sendRoutes(app: FastifyInstance): Promise<void> {
  const repo = new EmailSendsRepository(app.db);
  const domainResolver = new DomainResolver(new DomainRepository(app.db));

  app.post('/send', {
    schema: {
      body: SendEmailBodySchema,
    },
  }, async (request, reply) => {
    const body = request.body as {
      dedup_key: string;
      location_id: string;
      to: string;
      subject: string;
      html: string;
      text: string;
      entity_type?: string;
      entity_id?: string;
    };

    // (1) Resolve domain
    let domain;
    try {
      domain = await domainResolver.resolve(body.location_id);
    } catch (err) {
      if (err instanceof DomainNotConfiguredError) {
        return reply.status(422).send({ error: 'domain_not_configured', location_id: body.location_id });
      }
      if (err instanceof DomainNotVerifiedError) {
        return reply.status(422).send({ error: 'domain_not_verified', location_id: body.location_id });
      }
      throw err;
    }

    // (2) Check dedup
    const existing = await repo.findByDedupKey(body.dedup_key);
    if (existing) {
      return reply.status(200).send({ email_id: existing.id, status: existing.status });
    }

    // (3) Insert
    const send = await repo.create({
      dedup_key: body.dedup_key,
      location_id: body.location_id,
      domain_id: domain.id,
      to_email: body.to,
      subject: body.subject,
      entity_type: body.entity_type ?? null,
      entity_id: body.entity_id ?? null,
    });

    // (4) Enqueue
    await app.queues.transactionalSend.add('send', {
      emailSendId: send.id,
      to: body.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
    }, {
      attempts: 5,
      backoff: { type: 'custom' },
    });

    // (5) Return
    return reply.status(200).send({ email_id: send.id, status: 'queued' });
  });
}

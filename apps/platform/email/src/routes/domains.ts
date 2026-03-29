import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { DomainRepository, SendingDomainSchema } from '../repositories/domain-repository.js';
import { DomainResolver } from '../services/domain-resolver.js';
import { env } from '../env.js';

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  const repo = new DomainRepository(app.db);
  const resolver = new DomainResolver(repo);

  const CreateBodySchema = Type.Object({
    location_id: Type.String(),
    domain: Type.String(),
    from_name: Type.String(),
    from_email: Type.String(),
  });

  const IdParamsSchema = Type.Object({ id: Type.String() });
  const ErrorSchema = Type.Object({ error: Type.String() });

  // POST /domains
  app.post('/domains', {
    schema: {
      body: CreateBodySchema,
      response: { 201: SendingDomainSchema, 409: ErrorSchema },
    },
  }, async (request, reply) => {
    const body = request.body as {
      location_id: string;
      domain: string;
      from_name: string;
      from_email: string;
    };
    try {
      const domain = await repo.create(body);
      return reply.status(201).send(domain);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return reply.status(409).send({ error: 'location_already_configured' });
      }
      throw err;
    }
  });

  // GET /domains
  app.get('/domains', {
    schema: {
      response: { 200: Type.Object({ domains: Type.Array(SendingDomainSchema) }) },
    },
  }, async (_request, reply) => {
    const domains = await repo.findAll();
    return reply.send({ domains });
  });

  // GET /domains/:id — live SendGrid verification sync when sendgrid_domain_id is set
  app.get('/domains/:id', {
    schema: {
      params: IdParamsSchema,
      response: { 200: SendingDomainSchema, 404: ErrorSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let domain = await repo.findById(id);
    if (!domain) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (domain.sendgrid_domain_id) {
      const sgResp = await fetch(
        `https://api.sendgrid.com/v3/whitelabel/domains/${domain.sendgrid_domain_id}`,
        { headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}` } },
      );
      if (sgResp.ok) {
        const data = await sgResp.json() as { valid: boolean };
        if (data.valid !== domain.is_verified) {
          await repo.updateVerified(id, data.valid);
          resolver.invalidate(domain.location_id);
          domain = (await repo.findById(id))!;
        }
      }
    }

    return reply.send(domain);
  });

  // DELETE /domains/:id
  app.delete('/domains/:id', {
    schema: {
      params: IdParamsSchema,
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const domain = await repo.findById(id);
    if (!domain) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const hasRecentSends = await repo.hasSentEmailsIn30Days(id);
    if (hasRecentSends) {
      return reply.status(409).send({ error: 'domain_has_recent_sends' });
    }

    await repo.delete(id);
    resolver.invalidate(domain.location_id);
    return reply.send({ ok: true });
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

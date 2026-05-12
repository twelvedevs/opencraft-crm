import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@ortho/logger';
import { DomainRepository } from '../repositories/domain-repository.js';
import { SpamCheckerService } from '../services/spam-checker.js';
import { env } from '../env.js';

const log = createLogger('email-service:spam-check');

const SpamCheckBodySchema = Type.Object({
  location_id: Type.Optional(Type.String()),
  subject: Type.String(),
  html: Type.String(),
  text: Type.String(),
});

export async function spamCheckRoutes(app: FastifyInstance): Promise<void> {
  app.post('/spam-check', {
    schema: { tags: ['Spam Check'], summary: 'Check email spam score', body: SpamCheckBodySchema } as object,
  }, async (request, reply) => {
    const body = request.body as {
      location_id?: string;
      subject: string;
      html: string;
      text: string;
    };

    log.info({ location_id: body.location_id }, 'POST /spam-check received');

    const checker = new SpamCheckerService(
      new DomainRepository(app.db),
      env.SPAM_SCORE_THRESHOLD_DEFAULT ?? 5.0,
    );

    const result = await checker.check({
      locationId: body.location_id,
      subject: body.subject,
      html: body.html,
      text: body.text,
    });

    log.info({ location_id: body.location_id, score: result.score, passed: result.passed }, 'spam check complete');
    return reply.status(200).send(result);
  });
}

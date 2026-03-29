import type { FastifyInstance } from 'fastify';
import { SendgridSignatureVerifier } from '../services/sendgrid-signature-verifier.js';
import { WebhookProcessor, type SendgridEvent } from '../services/webhook-processor.js';
import { env } from '../env.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Override JSON parser within this plugin scope to capture raw body for ECDSA verification
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const verifier = new SendgridSignatureVerifier(env.SENDGRID_WEBHOOK_SIGNING_KEY_SECRET_ARN);
  const processor = new WebhookProcessor(app.db, app.eventBus);

  app.post('/webhooks/sendgrid', async (request, reply) => {
    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
    const signature =
      (request.headers['x-twilio-email-event-webhook-signature'] as string | undefined) ?? '';
    const timestamp =
      (request.headers['x-twilio-email-event-webhook-timestamp'] as string | undefined) ?? '';

    const isValid = await verifier.verify({ rawBody, signature, timestamp });
    if (!isValid) {
      return reply.status(403).send({ error: 'invalid_signature' });
    }

    const events = request.body as SendgridEvent[];

    // Fire-and-forget — processBatch handles its own per-event error isolation
    void processor.processBatch(events);

    return reply.status(200).send({ received: events.length });
  });
}

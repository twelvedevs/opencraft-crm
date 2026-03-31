import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { MessagesRepository } from '../repositories/messages.repo.js';
import { OptOutsRepository } from '../repositories/opt-outs.repo.js';
import { OptOutRegistry } from '../services/opt-out-registry.js';
import {
  validateTwilioSignature,
  classifyInboundMessage,
} from '../services/twilio-webhook.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const messagesRepo = new MessagesRepository(app.db);
  const optOutsRepo = new OptOutsRepository(app.db);
  const optOutRegistry = new OptOutRegistry(optOutsRepo);

  // Signature validation preHandler for webhook routes
  const validateSignature = async (
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) => {
    const signature = request.headers['x-twilio-signature'] as string | undefined;
    if (!signature) {
      return reply.status(403).send({ error: 'missing_signature' });
    }

    const protocol = request.headers['x-forwarded-proto'] ?? request.protocol;
    const host = request.headers['host'] ?? 'localhost';
    const url = `${protocol}://${host}${request.url}`;
    const params = (request.body as Record<string, string>) ?? {};

    if (!validateTwilioSignature(env.TWILIO_AUTH_TOKEN, signature, url, params)) {
      return reply.status(403).send({ error: 'invalid_signature' });
    }
  };

  // POST /webhooks/twilio/inbound
  app.post(
    '/webhooks/twilio/inbound',
    { preHandler: validateSignature },
    async (request, reply) => {
      const params = request.body as Record<string, string>;
      const from = params['From'] ?? '';
      const to = params['To'] ?? '';
      const body = params['Body'] ?? '';

      // Collect media URLs (MediaUrl0..MediaUrl9)
      const mediaUrls: string[] = [];
      for (let i = 0; i <= 9; i++) {
        const url = params[`MediaUrl${i}`];
        if (url) mediaUrls.push(url);
      }

      const messageType = classifyInboundMessage(body);

      // Insert inbound message
      const message = await messagesRepo.create({
        direction: 'inbound',
        to_number: to,
        from_number: from,
        body: body || null,
        media_urls: mediaUrls.length > 0 ? mediaUrls : null,
        message_type: messageType,
        status: 'received',
        received_at: new Date(),
      });

      // Handle opt-out actions
      if (messageType === 'stop') {
        await optOutsRepo.create(from, 'stop_reply');
      } else if (messageType === 'unstop') {
        const existed = await optOutRegistry.remove(from);
        // existed is used by US-006 for event publishing
        void existed;
      }

      return reply
        .status(200)
        .header('Content-Type', 'text/xml')
        .send('<Response></Response>');
    },
  );

  // POST /webhooks/twilio/status
  app.post(
    '/webhooks/twilio/status',
    { preHandler: validateSignature },
    async (request, reply) => {
      const params = request.body as Record<string, string>;
      const messageSid = params['MessageSid'] ?? '';
      const messageStatus = params['MessageStatus'] ?? '';
      const errorCode = params['ErrorCode'];
      const errorMessage = params['ErrorMessage'];

      const message = await messagesRepo.findByTwilioSid(messageSid);
      if (!message) {
        app.log.warn({ messageSid }, 'Status callback for unknown message');
        return reply.status(200).send({ ok: true });
      }

      if (messageStatus === 'delivered') {
        await messagesRepo.updateStatus(message.id, 'delivered', {
          delivered_at: new Date(),
        });
      } else if (
        messageStatus === 'failed' ||
        messageStatus === 'undelivered'
      ) {
        await messagesRepo.updateStatus(message.id, messageStatus, {
          error_code: errorCode,
          error_message: errorMessage,
        });
      } else {
        // queued, sending, sent — update status only
        await messagesRepo.updateStatus(message.id, messageStatus);
      }

      return reply.status(200).send({ ok: true });
    },
  );
}

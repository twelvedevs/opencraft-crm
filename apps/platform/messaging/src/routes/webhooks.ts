import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { MessagesRepository } from '../repositories/messages.repo.js';
import { NumbersRepository } from '../repositories/numbers.repo.js';
import { OptOutsRepository } from '../repositories/opt-outs.repo.js';
import { OptOutRegistry } from '../services/opt-out-registry.js';
import {
  validateTwilioSignature,
  classifyInboundMessage,
} from '../services/twilio-webhook.js';
import {
  publishInboundMessageReceived,
  publishMessageDelivered,
  publishMessageFailed,
  publishOptOutReceived,
  publishOptOutRemoved,
} from '../events/publisher.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const messagesRepo = new MessagesRepository(app.db);
  const numbersRepo = new NumbersRepository(app.db);
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
    { preHandler: validateSignature, schema: { tags: ['Webhooks'], summary: 'Twilio inbound message webhook' } as object },
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

      // Resolve location_id from the 'to' number (the practice's Twilio number)
      const numberRecord = await numbersRepo.findByPhoneNumber(to);
      const locationId = numberRecord?.location_id ?? null;

      // Publish inbound_message.received event
      try {
        await publishInboundMessageReceived(app.eventBus, {
          message_id: message.id,
          from_number: from,
          to_number: to,
          body: body || null,
          media_urls: mediaUrls.length > 0 ? mediaUrls : null,
          received_at: message.received_at ?? new Date().toISOString(),
          message_type: messageType,
        });
      } catch (err) {
        app.log.error({ err, message_id: message.id }, 'Failed to publish inbound_message.received event');
      }

      // Handle opt-out actions
      if (messageType === 'stop') {
        await optOutsRepo.create(from, 'stop_reply');
        try {
          await publishOptOutReceived(app.eventBus, {
            phone_number: from,
            opted_out_at: new Date().toISOString(),
            source: 'stop_reply',
            location_id: locationId,
          });
        } catch (err) {
          app.log.error({ err, phone_number: from }, 'Failed to publish opt_out.received event');
        }
      } else if (messageType === 'unstop') {
        const existed = await optOutRegistry.remove(from);
        if (existed) {
          try {
            await publishOptOutRemoved(app.eventBus, {
              phone_number: from,
              removed_at: new Date().toISOString(),
            });
          } catch (err) {
            app.log.error({ err, phone_number: from }, 'Failed to publish opt_out.removed event');
          }
        }
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
    { preHandler: validateSignature, schema: { tags: ['Webhooks'], summary: 'Twilio status callback webhook' } as object },
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
        const deliveredAt = new Date();
        await messagesRepo.updateStatus(message.id, 'delivered', {
          delivered_at: deliveredAt,
        });

        // Resolve location_id from from_number
        const numberRecord = await numbersRepo.findByPhoneNumber(message.from_number);
        try {
          await publishMessageDelivered(app.eventBus, {
            message_id: message.id,
            twilio_sid: message.twilio_sid,
            to_number: message.to_number,
            from_number: message.from_number,
            location_id: numberRecord?.location_id ?? null,
            delivered_at: deliveredAt.toISOString(),
          });
        } catch (err) {
          app.log.error({ err, message_id: message.id }, 'Failed to publish message.delivered event');
        }
      } else if (
        messageStatus === 'failed' ||
        messageStatus === 'undelivered'
      ) {
        await messagesRepo.updateStatus(message.id, messageStatus, {
          error_code: errorCode,
          error_message: errorMessage,
        });

        // Resolve location_id from from_number
        const numberRecord = await numbersRepo.findByPhoneNumber(message.from_number);
        try {
          await publishMessageFailed(app.eventBus, {
            message_id: message.id,
            twilio_sid: message.twilio_sid,
            to_number: message.to_number,
            from_number: message.from_number,
            location_id: numberRecord?.location_id ?? null,
            error_code: errorCode ?? null,
            error_message: errorMessage ?? null,
          });
        } catch (err) {
          app.log.error({ err, message_id: message.id }, 'Failed to publish message.failed event');
        }
      } else {
        // queued, sending, sent — update status only, no event
        await messagesRepo.updateStatus(message.id, messageStatus);
      }

      return reply.status(200).send({ ok: true });
    },
  );
}

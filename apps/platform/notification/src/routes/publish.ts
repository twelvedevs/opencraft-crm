import { createSecretKey } from 'crypto';
import { type FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { validateChannelPattern } from '../services/channel-validator.js';
import type { Publisher } from '../services/publisher.js';
import type { RateLimiter } from '../services/rate-limiter.js';

const MAX_PAYLOAD_BYTES = 4096;

const PublishBody = Type.Object({
  channel: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  body: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

type PublishBodyType = Static<typeof PublishBody>;

export interface PublishRouteOptions {
  publisher: Publisher;
  rateLimiter: RateLimiter;
  jwtSecret: string;
}

export async function publishRoute(
  fastify: FastifyInstance,
  opts: PublishRouteOptions,
): Promise<void> {
  const secretKey = createSecretKey(Buffer.from(opts.jwtSecret, 'utf-8'));

  fastify.post<{ Body: PublishBodyType }>(
    '/notifications/publish',
    {
      schema: {
        body: PublishBody,
      },
    },
    async (request, reply) => {
      // Validate Authorization header
      const authHeader = request.headers['authorization'];
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'missing_token' });
      }

      const token = authHeader.slice('Bearer '.length);
      try {
        await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
      } catch {
        return reply.status(403).send({ error: 'invalid_token' });
      }

      const { channel, title, body, payload } = request.body;

      // Validate channel pattern
      if (!validateChannelPattern(channel)) {
        return reply.status(400).send({ error: 'invalid_channel_pattern' });
      }

      // Validate payload size if provided
      if (payload !== undefined) {
        const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
        if (payloadBytes > MAX_PAYLOAD_BYTES) {
          return reply.status(400).send({ error: 'payload_too_large' });
        }
      }

      // Check rate limit
      const { allowed, retryAfterSeconds } = await opts.rateLimiter.checkAndIncrement(channel);
      if (!allowed) {
        void reply.header('Retry-After', String(retryAfterSeconds ?? 60));
        return reply.status(429).send({ error: 'rate_limit_exceeded' });
      }

      // Publish notification
      const result = await opts.publisher.publish({ channel, title, body, payload });

      return reply.status(201).send({ notification_id: result.notification_id });
    },
  );
}

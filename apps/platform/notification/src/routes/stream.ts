import { createSecretKey, randomUUID } from 'crypto';
import { type FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { validateChannelPattern, validateChannelAccess } from '../services/channel-validator.js';
import type { SseManager, SseConnection } from '../services/sse-manager.js';
import type { NotificationsRepo } from '../repositories/notifications.repo.js';

const MISSED_LIMIT = 200;
const KEEPALIVE_INTERVAL_MS = 30_000;

export interface StreamRouteOptions {
  sseManager: SseManager;
  repo: NotificationsRepo;
  jwtSecret: string;
}

export async function streamRoute(
  fastify: FastifyInstance,
  opts: StreamRouteOptions,
): Promise<void> {
  const secretKey = createSecretKey(Buffer.from(opts.jwtSecret, 'utf-8'));

  fastify.get('/notifications/stream', async (request, reply) => {
    // Validate Authorization
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' });
    }

    const token = authHeader.slice('Bearer '.length);
    let jwtClaims: { sub: string; locations?: string[] };
    try {
      const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
      if (!payload.sub) {
        return reply.status(403).send({ error: 'invalid_token' });
      }
      jwtClaims = {
        sub: payload.sub,
        locations: payload['locations'] as string[] | undefined,
      };
    } catch {
      return reply.status(403).send({ error: 'invalid_token' });
    }

    // Parse and validate channels query param
    const channelsParam = (request.query as Record<string, string>)['channels'];
    if (!channelsParam) {
      return reply.status(400).send({ error: 'channels_required' });
    }

    const channels = channelsParam
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    if (channels.length === 0) {
      return reply.status(400).send({ error: 'channels_required' });
    }

    for (const channel of channels) {
      if (!validateChannelPattern(channel)) {
        return reply.status(400).send({ error: 'invalid_channel_pattern', channel });
      }
      if (!validateChannelAccess(channel, jwtClaims)) {
        return reply.status(403).send({ error: 'channel_access_denied', channel });
      }
    }

    // Hijack the connection and take over raw SSE streaming
    const connectionId = randomUUID();
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Connection-ID': connectionId,
    });

    // Replay missed notifications if Last-Event-ID is present
    const lastEventId = request.headers['last-event-id'];
    if (lastEventId && typeof lastEventId === 'string') {
      const { rows, truncated } = await opts.repo.findMissed({
        channels,
        afterSeq: lastEventId,
        limit: MISSED_LIMIT,
      });

      if (truncated) {
        const firstSeq = rows[0]?.seq;
        reply.raw.write(
          `event: replay-truncated\ndata: ${JSON.stringify({ replayed: rows.length, first_seq: firstSeq })}\n\n`,
        );
      }

      for (const row of rows) {
        reply.raw.write(`event: notification\ndata: ${JSON.stringify(row)}\n\n`);
      }
    }

    // Register connection with SseManager
    const conn: SseConnection = {
      id: connectionId,
      userId: jwtClaims.sub,
      channels: new Set(channels),
      reply,
      connectionId,
    };
    opts.sseManager.register(conn);

    // Start 30s keepalive interval
    const keepaliveTimer = setInterval(() => {
      opts.sseManager.sendKeepalive(conn);
    }, KEEPALIVE_INTERVAL_MS);

    // Wait until client disconnects
    await new Promise<void>((resolve) => {
      reply.raw.on('close', () => {
        clearInterval(keepaliveTimer);
        opts.sseManager.deregister(conn);
        resolve();
      });
    });
  });
}

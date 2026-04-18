import { type FastifyInstance } from 'fastify';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Redis } from 'ioredis';
import { validateChannelPattern, validateChannelAccess } from '../services/channel-validator.js';
import type { NotificationsRepo, NotificationRow } from '../repositories/notifications.repo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface NotificationsRouteOptions {
  repo: NotificationsRepo;
  redis: Redis;
  jwksUrl: string;
}

function rowToResponse(row: NotificationRow) {
  return {
    notification_id: row.id,
    channel: row.channel,
    title: row.title,
    body: row.body,
    payload: row.payload,
    read: row.read,
    created_at: row.created_at,
  };
}

async function parseUserJwt(
  authHeader: string | undefined,
  jwks: ReturnType<typeof createRemoteJWKSet>,
): Promise<{ sub: string; locations?: string[] }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('missing_token');
  }
  const token = authHeader.slice('Bearer '.length);
  const { payload } = await jwtVerify(token, jwks, { algorithms: ['RS256'] });
  if (!payload.sub) throw new Error('no sub');
  return {
    sub: payload.sub,
    locations: payload['locations'] as string[] | undefined,
  };
}

export async function notificationsRoute(
  fastify: FastifyInstance,
  opts: NotificationsRouteOptions,
): Promise<void> {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  const { repo, redis } = opts;

  // GET /notifications — paginated notification history
  fastify.get('/notifications', { schema: { tags: ['Notifications'], summary: 'List notifications' } as object }, async (request, reply) => {
    let jwtClaims: { sub: string; locations?: string[] };
    try {
      jwtClaims = await parseUserJwt(request.headers['authorization'], jwks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid_token';
      if (msg === 'missing_token') return reply.status(401).send({ error: 'missing_token' });
      return reply.status(403).send({ error: 'invalid_token' });
    }

    // Parse query params
    const query = request.query as Record<string, string | undefined>;
    const channelsParam = query['channels'];
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

    // Validate channel patterns and access
    for (const channel of channels) {
      if (!validateChannelPattern(channel)) {
        return reply.status(400).send({ error: 'invalid_channel_pattern', channel });
      }
      if (!validateChannelAccess(channel, jwtClaims)) {
        return reply.status(403).send({ error: 'channel_access_denied', channel });
      }
    }

    // Parse optional params
    const unreadParam = query['unread'];
    const unread = unreadParam === 'true' || unreadParam === '1';

    const limitParam = query['limit'];
    let limit = DEFAULT_LIMIT;
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, MAX_LIMIT);
      }
    }

    const before = query['before'];

    // Fetch history
    const { rows, nextCursor, totalUnread } = await repo.findHistory({
      channels,
      userId: jwtClaims.sub,
      unread,
      before,
      limit,
    });

    void reply.header('X-Total-Count', String(totalUnread));

    return reply.status(200).send({
      notifications: rows.map(rowToResponse),
      next_cursor: nextCursor,
    });
  });

  // POST /notifications/read-all — mark all unread in channels as read
  fastify.post('/notifications/read-all', { schema: { tags: ['Notifications'], summary: 'Mark all notifications as read' } as object }, async (request, reply) => {
    let jwtClaims: { sub: string; locations?: string[] };
    try {
      jwtClaims = await parseUserJwt(request.headers['authorization'], jwks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid_token';
      if (msg === 'missing_token') return reply.status(401).send({ error: 'missing_token' });
      return reply.status(403).send({ error: 'invalid_token' });
    }

    const body = request.body as { channels?: unknown };
    if (!body || !Array.isArray(body.channels) || body.channels.length === 0) {
      return reply.status(400).send({ error: 'channels_required' });
    }

    const channels = body.channels as string[];

    for (const channel of channels) {
      if (typeof channel !== 'string' || !validateChannelPattern(channel)) {
        return reply.status(400).send({ error: 'invalid_channel_pattern', channel });
      }
      if (!validateChannelAccess(channel, jwtClaims)) {
        return reply.status(403).send({ error: 'channel_access_denied', channel });
      }
    }

    const originatingConnectionId = request.headers['x-connection-id'] as string | undefined;
    const { ids, count } = await repo.markAllRead(jwtClaims.sub, channels);

    await redis.publish(
      `notif:user:${jwtClaims.sub}:reads`,
      JSON.stringify({ notification_ids: ids, originating_connection_id: originatingConnectionId }),
    );

    return reply.status(200).send({ marked: count });
  });

  // POST /notifications/:id/read — mark a single notification as read
  fastify.post('/notifications/:id/read', { schema: { tags: ['Notifications'], summary: 'Mark notification as read' } as object }, async (request, reply) => {
    let jwtClaims: { sub: string; locations?: string[] };
    try {
      jwtClaims = await parseUserJwt(request.headers['authorization'], jwks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid_token';
      if (msg === 'missing_token') return reply.status(401).send({ error: 'missing_token' });
      return reply.status(403).send({ error: 'invalid_token' });
    }

    const { id: notificationId } = request.params as { id: string };
    const originatingConnectionId = request.headers['x-connection-id'] as string | undefined;

    const found = await repo.markRead(jwtClaims.sub, notificationId);
    if (!found) {
      return reply.status(404).send({ error: 'notification_not_found' });
    }

    await redis.publish(
      `notif:user:${jwtClaims.sub}:reads`,
      JSON.stringify({ notification_id: notificationId, originating_connection_id: originatingConnectionId }),
    );

    return reply.status(200).send({});
  });
}

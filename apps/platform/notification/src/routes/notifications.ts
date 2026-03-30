import { createSecretKey } from 'crypto';
import { type FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { validateChannelPattern, validateChannelAccess } from '../services/channel-validator.js';
import type { NotificationsRepo, NotificationRow } from '../repositories/notifications.repo.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface NotificationsRouteOptions {
  repo: NotificationsRepo;
  jwtSecret: string;
}

function parseUserJwt(
  authHeader: string | undefined,
  secretKey: ReturnType<typeof createSecretKey>,
): Promise<{ sub: string; locations?: string[] }> | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  return jwtVerify(token, secretKey, { algorithms: ['HS256'] })
    .then(({ payload }) => {
      if (!payload.sub) throw new Error('no sub');
      return {
        sub: payload.sub,
        locations: payload['locations'] as string[] | undefined,
      };
    });
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

export async function notificationsRoute(
  fastify: FastifyInstance,
  opts: NotificationsRouteOptions,
): Promise<void> {
  const secretKey = createSecretKey(Buffer.from(opts.jwtSecret, 'utf-8'));

  // GET /notifications — paginated notification history
  fastify.get('/notifications', async (request, reply) => {
    // Validate Authorization
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' });
    }

    let jwtClaims: { sub: string; locations?: string[] };
    try {
      const result = parseUserJwt(authHeader, secretKey);
      if (!result) {
        return reply.status(401).send({ error: 'missing_token' });
      }
      jwtClaims = await result;
    } catch {
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
    const { rows, nextCursor, totalUnread } = await opts.repo.findHistory({
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
}

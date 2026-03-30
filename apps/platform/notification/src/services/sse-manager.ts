import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';

export interface SseConnection {
  id: string;
  userId: string;
  channels: Set<string>;
  reply: FastifyReply;
  connectionId: string;
}

const MAX_CONNECTIONS_PER_USER = 10;

function writeSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class SseManager {
  private readonly channelMap = new Map<string, Set<SseConnection>>();
  private readonly userMap = new Map<string, SseConnection[]>();

  constructor(private readonly redis: Redis) {
    this.subscribeToRedis();
  }

  private subscribeToRedis(): void {
    this.redis.psubscribe('notif:*', (err) => {
      if (err) {
        console.error('SseManager: psubscribe error', err);
      }
    });

    this.redis.on('pmessage', (_pattern: string, redisChannel: string, message: string) => {
      this.handleRedisMessage(redisChannel, message);
    });
  }

  private handleRedisMessage(redisChannel: string, message: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    // notif:channel:{channel} → fan-out notification to all subscribers
    if (redisChannel.startsWith('notif:channel:')) {
      const channel = redisChannel.slice('notif:channel:'.length);
      const connections = this.channelMap.get(channel);
      if (!connections) return;
      for (const conn of connections) {
        writeSseEvent(conn.reply, 'notification', data);
      }
      return;
    }

    // notif:user:{userId}:reads → cross-tab read-state sync
    const readsMatch = /^notif:user:(.+):reads$/.exec(redisChannel);
    if (readsMatch) {
      const userId = readsMatch[1];
      const connections = this.userMap.get(userId);
      if (!connections) return;

      const originatingConnectionId = data['originating_connection_id'] as string | undefined;
      const event = 'notification_ids' in data ? 'read-all' : 'read';

      for (const conn of connections) {
        if (conn.connectionId === originatingConnectionId) continue;
        writeSseEvent(conn.reply, event, data);
      }
    }
  }

  register(conn: SseConnection): void {
    // Enforce per-user connection limit before registering the new connection
    const existingUserConns = this.userMap.get(conn.userId);
    if (existingUserConns && existingUserConns.length >= MAX_CONNECTIONS_PER_USER) {
      const oldest = existingUserConns[0];
      writeSseEvent(oldest.reply, 'connection-limit', {});
      oldest.reply.raw.end();
      this.deregister(oldest);
    }

    // Add to channelMap
    for (const channel of conn.channels) {
      let set = this.channelMap.get(channel);
      if (!set) {
        set = new Set();
        this.channelMap.set(channel, set);
      }
      set.add(conn);
    }

    // Add to userMap (insertion order tracks oldest → newest)
    let userConns = this.userMap.get(conn.userId);
    if (!userConns) {
      userConns = [];
      this.userMap.set(conn.userId, userConns);
    }
    userConns.push(conn);
  }

  deregister(conn: SseConnection): void {
    // Remove from channelMap
    for (const channel of conn.channels) {
      const set = this.channelMap.get(channel);
      if (set) {
        set.delete(conn);
        if (set.size === 0) {
          this.channelMap.delete(channel);
        }
      }
    }

    // Remove from userMap
    const userConns = this.userMap.get(conn.userId);
    if (userConns) {
      const idx = userConns.indexOf(conn);
      if (idx !== -1) {
        userConns.splice(idx, 1);
      }
      if (userConns.length === 0) {
        this.userMap.delete(conn.userId);
      }
    }
  }

  sendKeepalive(conn: SseConnection): void {
    conn.reply.raw.write(': keepalive\n\n');
  }
}

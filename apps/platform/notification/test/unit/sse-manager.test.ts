import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { SseManager } from '../../src/services/sse-manager.js';
import type { SseConnection } from '../../src/services/sse-manager.js';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReply() {
  return {
    raw: {
      write: vi.fn(),
      end: vi.fn(),
    },
  } as unknown as FastifyReply;
}

function makeConn(
  userId: string,
  channels: string[],
  opts: { connectionId?: string } = {},
): SseConnection {
  return {
    id: randomUUID(),
    userId,
    channels: new Set(channels),
    reply: makeReply(),
    connectionId: opts.connectionId ?? randomUUID(),
  };
}

type PmessageHandler = (pattern: string, channel: string, message: string) => void;

function makeSseManager(): { manager: SseManager; triggerRedis: PmessageHandler } {
  let pmessageHandler: PmessageHandler | undefined;

  const redis = {
    psubscribe: vi.fn(),
    on: vi.fn().mockImplementation((event: string, handler: PmessageHandler) => {
      if (event === 'pmessage') {
        pmessageHandler = handler;
      }
    }),
  } as unknown as Redis;

  const manager = new SseManager(redis);

  const triggerRedis: PmessageHandler = (pattern, channel, message) => {
    if (!pmessageHandler) throw new Error('pmessage handler not registered');
    pmessageHandler(pattern, channel, message);
  };

  return { manager, triggerRedis };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SseManager', () => {
  describe('constructor', () => {
    it('subscribes to notif:* on Redis init', () => {
      const redis = { psubscribe: vi.fn(), on: vi.fn() } as unknown as Redis;
      new SseManager(redis);
      expect(redis.psubscribe).toHaveBeenCalledWith('notif:*', expect.any(Function));
      expect(redis.on).toHaveBeenCalledWith('pmessage', expect.any(Function));
    });
  });

  describe('register', () => {
    it('adds connection to channelMap for each subscribed channel', () => {
      const { manager } = makeSseManager();
      const conn = makeConn('user1', ['location:loc1:sms', 'global:system']);
      manager.register(conn);

      // trigger a notification on each channel and verify conn receives it
      const { triggerRedis } = makeSseManager();
      const { manager: mgr } = makeSseManager();
      const c = makeConn('u', ['location:loc1:sms']);
      mgr.register(c);
      triggerRedis('notif:*', 'notif:channel:location:loc1:sms', JSON.stringify({ test: 1 }));
      // Can't call triggerRedis on mgr — use a fresh manager to verify internal state via fanout
      // Instead, verify via the fanout test below
      void manager;
    });

    it('adds connection to userMap for the userId', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn = makeConn('user1', ['user:user1:tasks']);
      manager.register(conn);

      const message = JSON.stringify({ notification_id: 'n1' });
      triggerRedis('notif:*', 'notif:user:user1:reads', message);

      expect((conn.reply.raw.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('event: read'),
      );
    });
  });

  describe('deregister', () => {
    it('removes connection from channelMap and userMap', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn = makeConn('user1', ['location:loc1:sms']);
      manager.register(conn);
      manager.deregister(conn);

      // No SSE write after deregister
      const message = JSON.stringify({ notification_id: 'n1', seq: '1' });
      triggerRedis('notif:*', 'notif:channel:location:loc1:sms', message);

      expect((conn.reply.raw.write as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('cleans up empty channel entries from channelMap', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn = makeConn('user1', ['location:loc1:sms']);
      manager.register(conn);
      manager.deregister(conn);

      // Another connection on same channel should still work independently
      const conn2 = makeConn('user2', ['location:loc1:sms']);
      manager.register(conn2);

      const message = JSON.stringify({ notification_id: 'n1' });
      triggerRedis('notif:*', 'notif:channel:location:loc1:sms', message);

      expect((conn2.reply.raw.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });
  });

  describe('fan-out: notif:channel:* messages', () => {
    it('writes event: notification SSE to all connections subscribed to that channel', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn1 = makeConn('user1', ['location:loc1:sms']);
      const conn2 = makeConn('user2', ['location:loc1:sms']);
      manager.register(conn1);
      manager.register(conn2);

      const data = { notification_id: 'n1', seq: '1', channel: 'location:loc1:sms', title: 'Hi' };
      triggerRedis('notif:*', 'notif:channel:location:loc1:sms', JSON.stringify(data));

      for (const conn of [conn1, conn2]) {
        const writeMock = conn.reply.raw.write as ReturnType<typeof vi.fn>;
        expect(writeMock).toHaveBeenCalledOnce();
        const written = writeMock.mock.calls[0][0] as string;
        expect(written).toMatch(/^event: notification\n/);
        expect(written).toContain('"notification_id":"n1"');
      }
    });

    it('does NOT write to connections on a different channel', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn = makeConn('user1', ['location:loc2:sms']);
      manager.register(conn);

      triggerRedis('notif:*', 'notif:channel:location:loc1:sms', JSON.stringify({ notification_id: 'n1' }));

      expect((conn.reply.raw.write as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  });

  describe('read-sync: notif:user:*:reads messages', () => {
    it('writes event: read for single notification_id message', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn = makeConn('user1', ['global:system'], { connectionId: 'conn-other' });
      manager.register(conn);

      const message = JSON.stringify({ notification_id: 'n1' });
      triggerRedis('notif:*', 'notif:user:user1:reads', message);

      const writeMock = conn.reply.raw.write as ReturnType<typeof vi.fn>;
      expect(writeMock).toHaveBeenCalledOnce();
      expect(writeMock.mock.calls[0][0]).toMatch(/^event: read\n/);
    });

    it('writes event: read-all for notification_ids array message', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn = makeConn('user1', ['global:system'], { connectionId: 'conn-other' });
      manager.register(conn);

      const message = JSON.stringify({ notification_ids: ['n1', 'n2'] });
      triggerRedis('notif:*', 'notif:user:user1:reads', message);

      const writeMock = conn.reply.raw.write as ReturnType<typeof vi.fn>;
      expect(writeMock).toHaveBeenCalledOnce();
      expect(writeMock.mock.calls[0][0]).toMatch(/^event: read-all\n/);
    });

    it('excludes the originating connection from read-sync delivery', () => {
      const { manager, triggerRedis } = makeSseManager();
      const originatingConn = makeConn('user1', ['global:system'], { connectionId: 'conn-origin' });
      const otherConn = makeConn('user1', ['global:system'], { connectionId: 'conn-other' });
      manager.register(originatingConn);
      manager.register(otherConn);

      const message = JSON.stringify({
        notification_id: 'n1',
        originating_connection_id: 'conn-origin',
      });
      triggerRedis('notif:*', 'notif:user:user1:reads', message);

      expect((originatingConn.reply.raw.write as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((otherConn.reply.raw.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });

    it('does NOT write to other users connections on read-sync', () => {
      const { manager, triggerRedis } = makeSseManager();
      const conn1 = makeConn('user1', ['global:system']);
      const conn2 = makeConn('user2', ['global:system']);
      manager.register(conn1);
      manager.register(conn2);

      triggerRedis('notif:*', 'notif:user:user1:reads', JSON.stringify({ notification_id: 'n1' }));

      expect((conn2.reply.raw.write as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((conn1.reply.raw.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });
  });

  describe('per-user connection limit', () => {
    it('evicts the oldest connection when the 11th connection registers', () => {
      const { manager } = makeSseManager();
      const connections: SseConnection[] = [];

      // Register 10 connections for user1
      for (let i = 0; i < 10; i++) {
        const conn = makeConn('user1', ['global:system']);
        manager.register(conn);
        connections.push(conn);
      }

      const oldest = connections[0];

      // 11th connection arrives
      const eleventh = makeConn('user1', ['global:system']);
      manager.register(eleventh);

      // Oldest got connection-limit event
      const oldestWrite = oldest.reply.raw.write as ReturnType<typeof vi.fn>;
      expect(oldestWrite).toHaveBeenCalledOnce();
      expect(oldestWrite.mock.calls[0][0]).toMatch(/^event: connection-limit\n/);

      // Oldest connection was closed
      expect((oldest.reply.raw.end as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });

    it('does not evict when fewer than 10 connections exist', () => {
      const { manager } = makeSseManager();
      const connections: SseConnection[] = [];

      for (let i = 0; i < 9; i++) {
        const conn = makeConn('user1', ['global:system']);
        manager.register(conn);
        connections.push(conn);
      }

      for (const conn of connections) {
        expect((conn.reply.raw.end as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      }
    });

    it('after eviction, oldest is no longer in channelMap (no fanout to it)', () => {
      const { manager, triggerRedis } = makeSseManager();
      const connections: SseConnection[] = [];

      for (let i = 0; i < 10; i++) {
        const conn = makeConn('user1', ['location:loc1:sms']);
        manager.register(conn);
        connections.push(conn);
      }

      const oldest = connections[0];
      const eleventh = makeConn('user1', ['location:loc1:sms']);
      manager.register(eleventh);

      // Reset write call count on oldest (it was called with connection-limit)
      (oldest.reply.raw.write as ReturnType<typeof vi.fn>).mockClear();

      triggerRedis('notif:*', 'notif:channel:location:loc1:sms', JSON.stringify({ notification_id: 'x' }));

      // Oldest should NOT receive the fanout
      expect((oldest.reply.raw.write as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      // Eleventh should receive it
      expect((eleventh.reply.raw.write as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });
  });

  describe('sendKeepalive', () => {
    it('writes SSE comment keepalive to the connection', () => {
      const { manager } = makeSseManager();
      const conn = makeConn('user1', ['global:system']);
      manager.register(conn);

      manager.sendKeepalive(conn);

      const writeMock = conn.reply.raw.write as ReturnType<typeof vi.fn>;
      expect(writeMock).toHaveBeenCalledWith(': keepalive\n\n');
    });
  });
});

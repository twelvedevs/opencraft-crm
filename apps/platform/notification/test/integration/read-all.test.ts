import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTestContext,
  makeServiceToken,
  makeUserToken,
  resetSchema,
  truncateTables,
  SseCollector,
  type TestContext,
} from './helpers.js';

describe('POST /notifications/read-all', () => {
  let ctx: TestContext;
  const userId = randomUUID();
  const locId = randomUUID();
  const channel = `location:${locId}:alerts`;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetSchema(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateTables(ctx.db);
  });

  async function publishN(serviceToken: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/notifications/publish',
        headers: { Authorization: `Bearer ${serviceToken}` },
        body: { channel, title: `Notification ${i + 1}` },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json<{ notification_id: string }>().notification_id);
    }
    return ids;
  }

  it('marks all unread in channels and returns correct marked count', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const ids = await publishN(serviceToken, 3);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: { Authorization: `Bearer ${userToken}` },
      body: { channels: [channel] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ marked: number }>();
    expect(body.marked).toBe(3);

    // All rows exist in notification_reads
    const rows = await ctx.db('platform_notifications.notification_reads').where({
      user_id: userId,
    });
    const markedIds = rows.map((r: { notification_id: string }) => r.notification_id);
    for (const id of ids) {
      expect(markedIds).toContain(id);
    }
  });

  it('sends event: read-all to other SSE connections with full notification_ids array', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const ids = await publishN(serviceToken, 2);

    // Open SSE connection for same user
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });
    const ownConnId = collector.connectionId!;

    // Call read-all from a DIFFERENT connection (no X-Connection-ID)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: { Authorization: `Bearer ${userToken}` },
      body: { channels: [channel] },
    });
    expect(res.statusCode).toBe(200);

    const events = await collector.waitForEvents(1);
    collector.close();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('read-all');
    const data = events[0].data as Record<string, unknown>;
    const notifIds = data['notification_ids'] as string[];
    expect(notifIds.sort()).toEqual(ids.sort());
    // originating_connection_id should be absent (no X-Connection-ID sent)
    expect(data['originating_connection_id']).toBeUndefined();

    void ownConnId; // used for connection setup
  });

  it('X-Connection-ID suppresses read-all echo on originating connection', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    await publishN(serviceToken, 1);

    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });
    const ownConnId = collector.connectionId!;

    await ctx.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'X-Connection-ID': ownConnId,
      },
      body: { channels: [channel] },
    });

    await new Promise((r) => setTimeout(r, 300));
    collector.close();

    expect(collector.getEvents()).toHaveLength(0);
  });

  it('returns marked: 0 when nothing is unread', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: { Authorization: `Bearer ${userToken}` },
      body: { channels: [channel] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ marked: number }>().marked).toBe(0);
  });
});

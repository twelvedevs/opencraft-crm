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

describe('mark-read cross-tab sync', () => {
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

  async function publishNotification(serviceToken: string, ch: string, title: string) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel: ch, title },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ notification_id: string }>().notification_id;
  }

  it('mark-read inserts a notification_reads row in the DB', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const notifId = await publishNotification(serviceToken, channel, 'Read me');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${notifId}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);

    const rows = await ctx.db('platform_notifications.notification_reads').where({
      user_id: userId,
      notification_id: notifId,
    });
    expect(rows).toHaveLength(1);
  });

  it('second SSE connection receives event: read after mark-read', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const notifId = await publishNotification(serviceToken, channel, 'Sync me');

    // Open a SECOND SSE connection for the same user
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });
    const connId2 = collector.connectionId!;
    expect(connId2).toBeTruthy();

    // Mark read from a different connection (no X-Connection-ID header → no originating)
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${notifId}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);

    const events = await collector.waitForEvents(1);
    collector.close();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('read');
    const data = events[0].data as Record<string, unknown>;
    expect(data['notification_id']).toBe(notifId);
  });

  it('X-Connection-ID suppresses echo on the originating connection', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const notifId = await publishNotification(serviceToken, channel, 'No echo');

    // Connect SSE client
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });
    const ownConnId = collector.connectionId!;

    // Mark read sending X-Connection-ID = our own connection
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${notifId}/read`,
      headers: {
        Authorization: `Bearer ${userToken}`,
        'X-Connection-ID': ownConnId,
      },
    });
    expect(res.statusCode).toBe(200);

    // Wait 300ms — originating connection should NOT receive the event
    await new Promise((r) => setTimeout(r, 300));
    collector.close();

    expect(collector.getEvents()).toHaveLength(0);
  });

  it('calling mark-read twice is idempotent (no error)', async () => {
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const notifId = await publishNotification(serviceToken, channel, 'Idempotent');

    const res1 = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${notifId}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${notifId}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res2.statusCode).toBe(200);

    // Only one row in DB
    const rows = await ctx.db('platform_notifications.notification_reads').where({
      user_id: userId,
      notification_id: notifId,
    });
    expect(rows).toHaveLength(1);
  });

  it('mark-read on expired/non-existent notification returns 404', async () => {
    const userToken = await makeUserToken(userId, [locId]);
    const fakeId = randomUUID();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${fakeId}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

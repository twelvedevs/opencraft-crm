import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTestContext,
  makeServiceToken,
  makeUserToken,
  resetSchema,
  truncateTables,
  type TestContext,
} from './helpers.js';

describe('GET /notifications history', () => {
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

  async function publishOne(title: string): Promise<string> {
    const serviceToken = await makeServiceToken();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel, title },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ notification_id: string }>().notification_id;
  }

  it('returns history with correct read: true/false per item', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    const id1 = await publishOne('First');
    const id2 = await publishOne('Second');

    // Mark only id1 as read
    const markRes = await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${id1}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(markRes.statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications?channels=${channel}`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      data: Array<{ notification_id: string; read: boolean }>;
      nextCursor: string | null;
    }>();

    const n1 = body.data.find((n) => n.notification_id === id1);
    const n2 = body.data.find((n) => n.notification_id === id2);
    expect(n1?.read).toBe(true);
    expect(n2?.read).toBe(false);
  });

  it('unread=true filter returns only unread notifications', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    const id1 = await publishOne('Unread1');
    const id2 = await publishOne('Unread2');

    // Mark id1 as read
    await ctx.app.inject({
      method: 'POST',
      url: `/notifications/${id1}/read`,
      headers: { Authorization: `Bearer ${userToken}` },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications?channels=${channel}&unread=true`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ notification_id: string }> }>();
    const ids = body.data.map((n) => n.notification_id);
    expect(ids).not.toContain(id1);
    expect(ids).toContain(id2);
  });

  it('X-Total-Count header matches actual unread count (ignores pagination)', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    // Publish 5 notifications
    for (let i = 0; i < 5; i++) {
      await publishOne(`Notif ${i}`);
    }

    // Fetch with limit=2 — should still see 5 in X-Total-Count
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications?channels=${channel}&limit=2`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('5');
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toHaveLength(2);
  });

  it('pagination cursor advances correctly', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    // Publish 4 notifications
    for (let i = 0; i < 4; i++) {
      await publishOne(`Page ${i}`);
    }

    // Fetch first page (limit=2)
    const page1 = await ctx.app.inject({
      method: 'GET',
      url: `/notifications?channels=${channel}&limit=2`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json<{
      data: Array<{ notification_id: string }>;
      nextCursor: string | null;
    }>();
    expect(body1.data).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();

    // Fetch second page using cursor
    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/notifications?channels=${channel}&limit=2&before=${body1.nextCursor}`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json<{
      data: Array<{ notification_id: string }>;
      nextCursor: string | null;
    }>();
    expect(body2.data).toHaveLength(2);
    expect(body2.nextCursor).toBeNull();

    // No overlap between pages
    const ids1 = body1.data.map((n) => n.notification_id);
    const ids2 = body2.data.map((n) => n.notification_id);
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toHaveLength(0);

    // Total 4 unique IDs
    expect(new Set([...ids1, ...ids2]).size).toBe(4);
  });

  it('expired notifications are not returned', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    // Insert an already-expired notification directly into DB
    const expiredId = randomUUID();
    await ctx.db('platform_notifications.notifications').insert({
      id: expiredId,
      channel,
      title: 'Expired',
      expires_at: new Date(Date.now() - 1000),
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications?channels=${channel}`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ notification_id: string }> }>();
    const ids = body.data.map((n) => n.notification_id);
    expect(ids).not.toContain(expiredId);
  });
});

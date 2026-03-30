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

describe('publish → SSE stream fan-out', () => {
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

  it('SSE client subscribed to channel X receives event: notification on publish', async () => {
    const userToken = await makeUserToken(userId, [locId]);
    const serviceToken = await makeServiceToken();

    // Connect SSE client subscribed to channel
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });
    expect(collector.statusCode).toBe(200);
    expect(collector.connectionId).toBeTruthy();

    // Publish a notification to the channel
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel, title: 'Hello SSE', body: 'test body' },
    });
    expect(res.statusCode).toBe(201);
    const { notification_id } = res.json<{ notification_id: string }>();

    // Wait for the SSE event
    const events = await collector.waitForEvents(1);
    collector.close();

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('notification');
    const data = events[0].data as Record<string, unknown>;
    expect(data['notification_id']).toBe(notification_id);
    expect(data['channel']).toBe(channel);
    expect(data['title']).toBe('Hello SSE');
    expect(data['body']).toBe('test body');
  });

  it('SSE client subscribed to channel X receives nothing when publishing to channel Y', async () => {
    const locIdY = randomUUID();
    const channelY = `location:${locIdY}:alerts`;
    const userToken = await makeUserToken(userId, [locId, locIdY]);
    const serviceToken = await makeServiceToken();

    // Connect SSE client subscribed to channel X only
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });

    // Publish to channel Y
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel: channelY, title: 'Wrong channel' },
    });
    expect(res.statusCode).toBe(201);

    // Wait 300ms — no events should arrive
    await new Promise((r) => setTimeout(r, 300));
    collector.close();

    expect(collector.getEvents()).toHaveLength(0);
  });
});

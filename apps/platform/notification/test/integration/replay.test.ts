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

describe('SSE replay via Last-Event-ID', () => {
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

  async function publishNotifications(count: number): Promise<string[]> {
    const serviceToken = await makeServiceToken();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/notifications/publish',
        headers: { Authorization: `Bearer ${serviceToken}` },
        body: { channel, title: `Replay ${i + 1}` },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json<{ notification_id: string }>().notification_id);
    }
    return ids;
  }

  it('reconnect with Last-Event-ID replays missed notifications without duplicates', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    // Publish 3 notifications
    const allIds = await publishNotifications(3);

    // Find the seq of the first notification (simulating a client that received seq=1 then disconnected)
    const firstRow = await ctx.db('platform_notifications.notifications')
      .where({ id: allIds[0] })
      .first<{ seq: string }>();
    expect(firstRow).toBeTruthy();
    const afterSeq = firstRow!.seq;

    // Reconnect with Last-Event-ID = seq of first notification
    // Should replay the remaining 2 (allIds[1], allIds[2])
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
      'Last-Event-ID': afterSeq,
    });

    // Wait for replay events to arrive — there should be 2
    const events = await collector.waitForEvents(2, 3000);
    collector.close();

    // Replayed notifications come directly from NotificationRow (field: 'id'),
    // not from the Redis pub/sub payload (field: 'notification_id').
    const replayedNotifIds = events
      .filter((e) => e.event === 'notification')
      .map((e) => (e.data as Record<string, unknown>)['id'] as string);

    expect(replayedNotifIds).toHaveLength(2);
    expect(replayedNotifIds).toContain(allIds[1]);
    expect(replayedNotifIds).toContain(allIds[2]);
    expect(replayedNotifIds).not.toContain(allIds[0]);
  });

  it('reconnect with >200 missed sends replay-truncated event first, then 200 events', async () => {
    const userToken = await makeUserToken(userId, [locId]);

    // Publish 202 notifications
    // Insert directly into DB (faster than HTTP for large batches)
    const serviceToken = await makeServiceToken();

    // Publish 2 up front to get a "before" seq
    const seedIds = await publishNotifications(2);
    const seedRow = await ctx.db('platform_notifications.notifications')
      .where({ id: seedIds[0] })
      .first<{ seq: string }>();
    const afterSeq = seedRow!.seq;

    // Now insert 201 more notifications (exceeds 200 limit)
    const insertRows = Array.from({ length: 201 }, (_, i) => ({
      id: randomUUID(),
      channel,
      title: `Bulk ${i}`,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }));
    await ctx.db('platform_notifications.notifications').insert(insertRows);

    void serviceToken; // used indirectly via publishNotifications

    // Reconnect — should get replay-truncated + 200 notification events
    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
      'Last-Event-ID': afterSeq,
    });

    // Wait for 201 events: 1 replay-truncated + 200 notifications
    const events = await collector.waitForEvents(201, 10_000);
    collector.close();

    const truncatedEvent = events.find((e) => e.event === 'replay-truncated');
    expect(truncatedEvent).toBeTruthy();
    const truncData = truncatedEvent!.data as Record<string, unknown>;
    expect(truncData['replayed']).toBe(200);
    expect(typeof truncData['first_seq']).toBe('string');

    // replay-truncated should come FIRST
    expect(events[0].event).toBe('replay-truncated');

    const notifEvents = events.filter((e) => e.event === 'notification');
    expect(notifEvents).toHaveLength(200);
  });
});

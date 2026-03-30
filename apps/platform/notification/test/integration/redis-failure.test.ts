import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createTestContext,
  makeServiceToken,
  makeUserToken,
  resetSchema,
  truncateTables,
  SseCollector,
  TEST_REDIS_URL,
  type TestContext,
} from './helpers.js';
import { Publisher } from '../../src/services/publisher.js';
import type { PublishRetryJobData } from '../../src/services/publisher.js';

describe('Redis failure during publish', () => {
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
    vi.restoreAllMocks();
    // Clean up any BullMQ retry jobs from previous tests
    const cleanupQueue = new Queue('publish-retry', { connection: new Redis(TEST_REDIS_URL) });
    await cleanupQueue.obliterate({ force: true });
    await cleanupQueue.close();
  });

  it('DB write succeeds and BullMQ retry job is created when Redis.publish fails', async () => {
    // Spy on the redis.publish to make it fail
    const publishSpy = vi.spyOn(ctx.redis, 'publish').mockRejectedValueOnce(
      new Error('Redis connection lost'),
    );

    const serviceToken = await makeServiceToken();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel, title: 'Retry me' },
    });

    // HTTP response is still 201 (DB write succeeded)
    expect(res.statusCode).toBe(201);
    const { notification_id } = res.json<{ notification_id: string }>();

    // DB row was inserted
    const rows = await ctx.db('platform_notifications.notifications').where({
      id: notification_id,
    });
    expect(rows).toHaveLength(1);

    // Redis publish was attempted
    expect(publishSpy).toHaveBeenCalledOnce();

    // BullMQ job was enqueued — give it a moment to register
    await new Promise((r) => setTimeout(r, 100));

    const queue = new Queue<PublishRetryJobData>('publish-retry', {
      connection: new Redis(TEST_REDIS_URL),
    });
    const waiting = await queue.getWaiting();
    const delayed = await queue.getDelayed();
    const jobs = [...waiting, ...delayed];

    const job = jobs.find((j) => j.data.notification_id === notification_id);
    expect(job).toBeTruthy();
    expect(job!.data.channel).toBe(channel);
    expect(job!.data.title).toBe('Retry me');

    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('after Redis.publish recovers, SSE clients receive the notification via the normal path', async () => {
    // This test verifies the happy path still works (complementing the failure test above)
    const serviceToken = await makeServiceToken();
    const userToken = await makeUserToken(userId, [locId]);

    const collector = new SseCollector();
    await collector.connect(`${ctx.serverUrl}/notifications/stream?channels=${channel}`, {
      Authorization: `Bearer ${userToken}`,
    });

    // Normal publish (Redis is healthy)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel, title: 'Delivered' },
    });
    expect(res.statusCode).toBe(201);

    const events = await collector.waitForEvents(1);
    collector.close();

    expect(events[0].event).toBe('notification');
    expect((events[0].data as Record<string, unknown>)['title']).toBe('Delivered');
  });
});

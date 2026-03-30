import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTestContext,
  resetSchema,
  truncateTables,
  type TestContext,
} from './helpers.js';

describe('Cleanup worker — deleteExpired', () => {
  let ctx: TestContext;

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

  it('deleteExpired removes rows where expires_at < now()', async () => {
    const channel = `location:${randomUUID()}:alerts`;

    // Insert one expired and one valid notification
    const expiredId = randomUUID();
    const validId = randomUUID();

    await ctx.db('platform_notifications.notifications').insert([
      {
        id: expiredId,
        channel,
        title: 'Expired',
        expires_at: new Date(Date.now() - 1000), // 1 second ago
      },
      {
        id: validId,
        channel,
        title: 'Valid',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      },
    ]);

    const deleted = await ctx.repo.deleteExpired();

    expect(deleted).toBe(1);

    const remaining = await ctx.db('platform_notifications.notifications').whereIn('id', [
      expiredId,
      validId,
    ]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(validId);
  });

  it('notification_reads are cascade-deleted when notification is expired and deleted', async () => {
    const userId = randomUUID();
    const channel = `location:${randomUUID()}:alerts`;

    // Insert expired notification
    const expiredId = randomUUID();
    await ctx.db('platform_notifications.notifications').insert({
      id: expiredId,
      channel,
      title: 'Expired with read',
      expires_at: new Date(Date.now() - 1000),
    });

    // Insert a read receipt for this notification
    await ctx.db('platform_notifications.notification_reads').insert({
      user_id: userId,
      notification_id: expiredId,
    });

    // Verify read receipt exists
    const readsBefore = await ctx.db('platform_notifications.notification_reads').where({
      notification_id: expiredId,
    });
    expect(readsBefore).toHaveLength(1);

    // Run cleanup
    const deleted = await ctx.repo.deleteExpired();
    expect(deleted).toBe(1);

    // Read receipt should be cascade-deleted
    const readsAfter = await ctx.db('platform_notifications.notification_reads').where({
      notification_id: expiredId,
    });
    expect(readsAfter).toHaveLength(0);
  });

  it('deleteExpired returns 0 when nothing is expired', async () => {
    const channel = `location:${randomUUID()}:alerts`;

    await ctx.db('platform_notifications.notifications').insert({
      id: randomUUID(),
      channel,
      title: 'Future',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const deleted = await ctx.repo.deleteExpired();
    expect(deleted).toBe(0);
  });
});

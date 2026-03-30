import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Publisher } from '../../src/services/publisher.js';
import type { NotificationsRepo } from '../../src/repositories/notifications.repo.js';
import type { Redis } from 'ioredis';

// Minimal mock for BullMQ Queue — the publisher constructs it internally
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({}),
  })),
}));

import { Queue } from 'bullmq';

function makeRepo(): { insert: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn().mockResolvedValue({ id: 'notif-uuid-1', seq: '42' }),
  };
}

function makeRedis(): { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(1) };
}

describe('Publisher', () => {
  let repo: ReturnType<typeof makeRepo>;
  let redis: ReturnType<typeof makeRedis>;
  let publisher: Publisher;
  let mockQueueAdd: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeRepo();
    redis = makeRedis();
    publisher = new Publisher(
      repo as unknown as NotificationsRepo,
      redis as unknown as Redis,
    );
    // Grab the add mock from the Queue instance created in the Publisher constructor
    const MockQueue = Queue as unknown as ReturnType<typeof vi.fn>;
    mockQueueAdd = MockQueue.mock.results[MockQueue.mock.results.length - 1].value.add;
  });

  it('inserts into DB with correct fields including expires_at ~7 days out', async () => {
    const before = Date.now();
    await publisher.publish({ channel: 'location:loc1:alerts', title: 'Hello' });
    const after = Date.now();

    expect(repo.insert).toHaveBeenCalledOnce();
    const [insertArg] = repo.insert.mock.calls[0] as [
      {
        id: string;
        channel: string;
        title: string;
        body: undefined;
        payload: undefined;
        expires_at: Date;
      },
    ];

    expect(insertArg.channel).toBe('location:loc1:alerts');
    expect(insertArg.title).toBe('Hello');
    expect(insertArg.body).toBeUndefined();
    expect(insertArg.payload).toBeUndefined();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresMs = insertArg.expires_at.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 100);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs + 100);
  });

  it('publishes to Redis with namespaced key notif:channel:{channel}', async () => {
    await publisher.publish({ channel: 'location:loc1:alerts', title: 'Test' });

    expect(redis.publish).toHaveBeenCalledOnce();
    const [key, payload] = redis.publish.mock.calls[0] as [string, string];
    expect(key).toBe('notif:channel:location:loc1:alerts');

    const parsed = JSON.parse(payload) as {
      notification_id: string;
      seq: string;
      channel: string;
      title: string;
    };
    expect(parsed.notification_id).toBe('notif-uuid-1');
    expect(parsed.seq).toBe('42');
    expect(parsed.channel).toBe('location:loc1:alerts');
    expect(parsed.title).toBe('Test');
  });

  it('returns notification_id on Redis PUBLISH success', async () => {
    const result = await publisher.publish({ channel: 'global:system', title: 'Broadcast' });
    expect(result.notification_id).toBe('notif-uuid-1');
  });

  it('enqueues BullMQ job when Redis PUBLISH throws', async () => {
    redis.publish.mockRejectedValueOnce(new Error('Redis unavailable'));

    const result = await publisher.publish({
      channel: 'location:loc2:alerts',
      title: 'Retry me',
      body: 'body text',
      payload: { key: 'value' },
    });

    // Still returns notification_id
    expect(result.notification_id).toBe('notif-uuid-1');

    // BullMQ job was enqueued
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, jobData] = mockQueueAdd.mock.calls[0] as [
      string,
      {
        notification_id: string;
        channel: string;
        seq: string;
        title: string;
        body: string;
        payload: Record<string, unknown>;
      },
    ];
    expect(jobData.notification_id).toBe('notif-uuid-1');
    expect(jobData.channel).toBe('location:loc2:alerts');
    expect(jobData.seq).toBe('42');
    expect(jobData.title).toBe('Retry me');
    expect(jobData.body).toBe('body text');
    expect(jobData.payload).toEqual({ key: 'value' });
  });

  it('does NOT enqueue BullMQ job on Redis PUBLISH success', async () => {
    await publisher.publish({ channel: 'global:system', title: 'Success' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('Redis payload includes body and payload fields', async () => {
    await publisher.publish({
      channel: 'user:u1:tasks',
      title: 'Task',
      body: 'Do the thing',
      payload: { taskId: 123 },
    });

    const [, payloadStr] = redis.publish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payloadStr) as {
      body: string;
      payload: { taskId: number };
    };
    expect(parsed.body).toBe('Do the thing');
    expect(parsed.payload).toEqual({ taskId: 123 });
  });

  it('Redis payload nulls out missing body and payload', async () => {
    await publisher.publish({ channel: 'global:system', title: 'Minimal' });

    const [, payloadStr] = redis.publish.mock.calls[0] as [string, string];
    const parsed = JSON.parse(payloadStr) as { body: null; payload: null };
    expect(parsed.body).toBeNull();
    expect(parsed.payload).toBeNull();
  });
});

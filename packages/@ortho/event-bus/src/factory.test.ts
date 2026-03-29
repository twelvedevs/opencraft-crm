import { describe, it, expect, beforeEach } from 'vitest';
import { createEventBus } from './factory.js';
import { MockDriver } from './drivers/mock.js';

describe('createEventBus', () => {
  beforeEach(() => {
    delete process.env['EVENT_BUS_DRIVER'];
  });

  it('uses provided driver when options.driver is set', () => {
    const driver = new MockDriver();
    const bus = createEventBus({ driver });
    expect(bus).toBeDefined();
  });

  it('returns EventBus backed by provided driver', async () => {
    const driver = new MockDriver();
    const bus = createEventBus({ driver });
    const event = { event_type: 'test.event', payload: {} };
    await bus.publish(event);
    expect(driver.published).toHaveLength(1);
    expect(driver.published[0]).toEqual(event);
  });

  it('instantiates EventBridgeDriver when EVENT_BUS_DRIVER=eventbridge', () => {
    process.env['EVENT_BUS_DRIVER'] = 'eventbridge';
    process.env['EVENT_BRIDGE_BUS_NAME'] = 'test-bus';
    process.env['SQS_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123/test.fifo';
    try {
      expect(() => createEventBus()).not.toThrow();
    } finally {
      delete process.env['EVENT_BRIDGE_BUS_NAME'];
      delete process.env['SQS_QUEUE_URL'];
    }
  });

  it('instantiates RedisStreamsDriver when EVENT_BUS_DRIVER=redis', () => {
    process.env['EVENT_BUS_DRIVER'] = 'redis';
    expect(() => createEventBus()).not.toThrow();
  });

  it('throws when EVENT_BUS_DRIVER is not set', () => {
    expect(() => createEventBus()).toThrow(
      'EVENT_BUS_DRIVER must be set to "eventbridge" or "redis"'
    );
  });

  it('throws for an unknown EVENT_BUS_DRIVER value', () => {
    process.env['EVENT_BUS_DRIVER'] = 'kafka';
    expect(() => createEventBus()).toThrow(
      'EVENT_BUS_DRIVER must be set to "eventbridge" or "redis"'
    );
  });
});

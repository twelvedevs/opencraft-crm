import type { Driver, EventBus } from './types.js';
import { EventBusImpl } from './event-bus.js';
import { EventBridgeDriver } from './drivers/eventbridge.js';
import { RedisStreamsDriver } from './drivers/redis-streams.js';

export interface EventBusOptions {
  driver?: Driver;
}

export function createEventBus(options?: EventBusOptions): EventBus {
  if (options?.driver) {
    return new EventBusImpl(options.driver);
  }

  const driverName = process.env['EVENT_BUS_DRIVER'];

  if (driverName === 'eventbridge') {
    return new EventBusImpl(new EventBridgeDriver());
  }

  if (driverName === 'redis') {
    const redisUrl = process.env['REDIS_URL'];
    const consumerGroup = process.env['EVENT_BUS_CONSUMER_GROUP'];
    if (!redisUrl) throw new Error('REDIS_URL env var is required');
    if (!consumerGroup) throw new Error('EVENT_BUS_CONSUMER_GROUP env var is required');
    return new EventBusImpl(new RedisStreamsDriver({ redisUrl, consumerGroup }));
  }

  throw new Error('EVENT_BUS_DRIVER must be set to "eventbridge" or "redis"');
}

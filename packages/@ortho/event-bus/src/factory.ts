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
    return new EventBusImpl(new RedisStreamsDriver());
  }

  throw new Error('EVENT_BUS_DRIVER must be set to "eventbridge" or "redis"');
}

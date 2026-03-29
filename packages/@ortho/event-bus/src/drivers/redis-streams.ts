import type { Driver, EventHandler, OrthoEvent } from '../types.js';

// Stub — full implementation delivered in US-004
export class RedisStreamsDriver implements Driver {
  async publish(_event: OrthoEvent): Promise<void> {
    throw new Error('RedisStreamsDriver not yet implemented');
  }

  async start(_subscriptions: Map<string, EventHandler[]>): Promise<void> {
    throw new Error('RedisStreamsDriver not yet implemented');
  }

  async stop(): Promise<void> {
    throw new Error('RedisStreamsDriver not yet implemented');
  }
}

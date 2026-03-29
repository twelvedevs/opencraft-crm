import type { Driver, EventHandler, OrthoEvent } from '../types.js';

// Stub — full implementation delivered in US-003
export class EventBridgeDriver implements Driver {
  async publish(_event: OrthoEvent): Promise<void> {
    throw new Error('EventBridgeDriver not yet implemented');
  }

  async start(_subscriptions: Map<string, EventHandler[]>): Promise<void> {
    throw new Error('EventBridgeDriver not yet implemented');
  }

  async stop(): Promise<void> {
    throw new Error('EventBridgeDriver not yet implemented');
  }
}

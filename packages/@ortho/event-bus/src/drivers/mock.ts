import type { Driver, EventHandler, OrthoEvent } from '../types.js';

export class MockDriver implements Driver {
  readonly published: OrthoEvent[] = [];

  async publish(event: OrthoEvent): Promise<void> {
    this.published.push(event);
  }

  async start(_subscriptions: Map<string, EventHandler[]>): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    // no-op
  }
}

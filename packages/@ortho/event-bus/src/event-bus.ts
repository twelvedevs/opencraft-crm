import type { Driver, EventBus, EventHandler, OrthoEvent } from './types.js';

export class EventBusImpl implements EventBus {
  private readonly subscriptions = new Map<string, EventHandler[]>();
  private started = false;

  constructor(private readonly driver: Driver) {}

  subscribe(eventType: string, handler: EventHandler): void {
    if (this.started) {
      throw new Error('subscribe() called after start()');
    }
    const handlers = this.subscriptions.get(eventType) ?? [];
    handlers.push(handler);
    this.subscriptions.set(eventType, handlers);
  }

  async publish(event: OrthoEvent): Promise<void> {
    return this.driver.publish(event);
  }

  async start(): Promise<void> {
    this.started = true;
    if (this.subscriptions.size === 0) {
      console.warn('[EventBus] start() called with zero subscriptions');
      return;
    }
    return this.driver.start(this.subscriptions);
  }

  async stop(): Promise<void> {
    return this.driver.stop();
  }
}

import type { Driver, EventBus, EventHandler, OrthoEvent } from './types.js';
export declare class EventBusImpl implements EventBus {
    private readonly driver;
    private readonly subscriptions;
    private started;
    constructor(driver: Driver);
    subscribe(eventType: string, handler: EventHandler): void;
    publish(event: OrthoEvent): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=event-bus.d.ts.map
export class EventBusImpl {
    driver;
    subscriptions = new Map();
    started = false;
    constructor(driver) {
        this.driver = driver;
    }
    subscribe(eventType, handler) {
        if (this.started) {
            throw new Error('subscribe() called after start()');
        }
        const handlers = this.subscriptions.get(eventType) ?? [];
        handlers.push(handler);
        this.subscriptions.set(eventType, handlers);
    }
    async publish(event) {
        return this.driver.publish(event);
    }
    async start() {
        this.started = true;
        if (this.subscriptions.size === 0) {
            console.warn('[EventBus] start() called with zero subscriptions');
            return;
        }
        return this.driver.start(this.subscriptions);
    }
    async stop() {
        return this.driver.stop();
    }
}
//# sourceMappingURL=event-bus.js.map
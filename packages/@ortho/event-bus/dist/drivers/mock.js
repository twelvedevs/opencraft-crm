export class MockDriver {
    published = [];
    async publish(event) {
        this.published.push(event);
    }
    async start(_subscriptions) {
        // no-op
    }
    async stop() {
        // no-op
    }
}
//# sourceMappingURL=mock.js.map
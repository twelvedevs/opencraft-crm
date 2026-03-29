import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBusImpl } from './event-bus.js';
function makeMockDriver() {
    const publishCalls = [];
    const startCalls = [];
    let stopCallCount = 0;
    return {
        publishCalls,
        startCalls,
        get stopCallCount() {
            return stopCallCount;
        },
        async publish(event) {
            publishCalls.push(event);
        },
        async start(subscriptions) {
            startCalls.push(subscriptions);
        },
        async stop() {
            stopCallCount++;
        },
    };
}
const sampleEvent = {
    event_type: 'lead.created',
    entity_type: 'lead',
    entity_id: '123',
    payload: { name: 'Test' },
};
describe('EventBusImpl', () => {
    let driver;
    let bus;
    beforeEach(() => {
        driver = makeMockDriver();
        bus = new EventBusImpl(driver);
    });
    it('subscribe before start registers handler', () => {
        const handler = vi.fn();
        bus.subscribe('lead.created', handler);
        // no throw — that's the assertion
    });
    it('subscribe after start throws', async () => {
        await bus.start();
        expect(() => bus.subscribe('lead.created', vi.fn())).toThrow('subscribe() called after start()');
    });
    it('publish calls driver.publish with correct event', async () => {
        await bus.publish(sampleEvent);
        expect(driver.publishCalls).toHaveLength(1);
        expect(driver.publishCalls[0]).toBe(sampleEvent);
    });
    it('start with zero subscriptions calls console.warn and resolves without calling driver.start', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        await bus.start();
        expect(warn).toHaveBeenCalledOnce();
        expect(driver.startCalls).toHaveLength(0);
        warn.mockRestore();
    });
    it('start with subscriptions calls driver.start with correct map', async () => {
        const handler = vi.fn();
        bus.subscribe('lead.created', handler);
        await bus.start();
        expect(driver.startCalls).toHaveLength(1);
        expect(driver.startCalls[0].get('lead.created')).toEqual([handler]);
    });
    it('multiple handlers for same event type are both present in the map', async () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.subscribe('lead.created', h1);
        bus.subscribe('lead.created', h2);
        await bus.start();
        const handlers = driver.startCalls[0].get('lead.created');
        expect(handlers).toEqual([h1, h2]);
    });
    it('stop calls driver.stop', async () => {
        await bus.stop();
        expect(driver.stopCallCount).toBe(1);
    });
});
//# sourceMappingURL=event-bus.test.js.map
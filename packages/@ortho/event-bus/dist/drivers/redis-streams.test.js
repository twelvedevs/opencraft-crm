import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// ---------- ioredis mock ----------
const mockRedis = {
    xadd: vi.fn(),
    xgroup: vi.fn(),
    xreadgroup: vi.fn(),
    xack: vi.fn(),
    xpending: vi.fn(),
    quit: vi.fn(),
};
vi.mock('ioredis', () => ({
    Redis: vi.fn(() => mockRedis),
}));
// Import after mock is registered
const { RedisStreamsDriver } = await import('./redis-streams.js');
// ---------- helpers ----------
const OPTIONS = { redisUrl: 'redis://localhost:6379', consumerGroup: 'test-group' };
function makeMessage(id, event = {}) {
    const full = {
        event_type: 'test.event',
        payload: {},
        ...event,
    };
    const fields = [
        'event_type', full.event_type,
        'payload', JSON.stringify(full.payload),
    ];
    if (full.entity_type)
        fields.push('entity_type', full.entity_type);
    if (full.entity_id)
        fields.push('entity_id', full.entity_id);
    return ['stream:test.event', [[id, fields]]];
}
function xreadResult(id, event) {
    return [makeMessage(id, event)];
}
// ---------- tests ----------
describe('RedisStreamsDriver', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.xgroup.mockResolvedValue('OK');
        mockRedis.xack.mockResolvedValue(1);
        mockRedis.xpending.mockResolvedValue([0, null, null, null]);
        mockRedis.xadd.mockResolvedValue('1-0');
        mockRedis.quit.mockResolvedValue('OK');
        // Default: no messages
        mockRedis.xreadgroup.mockResolvedValue(null);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    // --------------------------------------------------
    it('publish calls XADD with correct stream name and MAXLEN', async () => {
        const driver = new RedisStreamsDriver(OPTIONS);
        const event = { event_type: 'lead.created', payload: { id: 1 }, entity_id: 'e1' };
        await driver.publish(event);
        expect(mockRedis.xadd).toHaveBeenCalledOnce();
        const args = mockRedis.xadd.mock.calls[0];
        expect(args[0]).toBe('stream:lead.created');
        expect(args[1]).toBe('MAXLEN');
        expect(args[2]).toBe('~');
        expect(args[3]).toBe('10000');
        expect(args[4]).toBe('*');
        // fields should include event_type and entity_id
        const fields = args.slice(5);
        expect(fields).toContain('event_type');
        expect(fields).toContain('lead.created');
        expect(fields).toContain('entity_id');
        expect(fields).toContain('e1');
        expect(fields).toContain('payload');
        expect(fields).toContain(JSON.stringify({ id: 1 }));
    });
    // --------------------------------------------------
    it('start creates consumer group (XGROUP CREATE with MKSTREAM)', async () => {
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [vi.fn()]]]);
        await driver.start(subs);
        await driver.stop();
        expect(mockRedis.xgroup).toHaveBeenCalledWith('CREATE', 'stream:test.event', OPTIONS.consumerGroup, '$', 'MKSTREAM');
    });
    // --------------------------------------------------
    it('start ignores BUSYGROUP error when consumer group already exists', async () => {
        mockRedis.xgroup.mockRejectedValueOnce(new Error('BUSYGROUP Consumer Group name already exists'));
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [vi.fn()]]]);
        await expect(driver.start(subs)).resolves.toBeUndefined();
        await driver.stop();
    });
    // --------------------------------------------------
    it('message received calls handlers in series and XACKs on success', async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        mockRedis.xreadgroup
            .mockResolvedValueOnce(xreadResult('1-0'))
            .mockResolvedValue(null);
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [handler]]]);
        await driver.start(subs);
        // Give loop time to process the message
        await new Promise((r) => setTimeout(r, 20));
        await driver.stop();
        expect(handler).toHaveBeenCalledOnce();
        expect(handler.mock.calls[0][0]).toMatchObject({ event_type: 'test.event' });
        expect(mockRedis.xack).toHaveBeenCalledWith('stream:test.event', OPTIONS.consumerGroup, '1-0');
    });
    // --------------------------------------------------
    it('calls multiple handlers in series for same event type', async () => {
        const order = [];
        const h1 = vi.fn().mockImplementation(async () => { order.push(1); });
        const h2 = vi.fn().mockImplementation(async () => { order.push(2); });
        mockRedis.xreadgroup
            .mockResolvedValueOnce(xreadResult('1-0'))
            .mockResolvedValue(null);
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [h1, h2]]]);
        await driver.start(subs);
        await new Promise((r) => setTimeout(r, 20));
        await driver.stop();
        expect(order).toEqual([1, 2]);
        expect(mockRedis.xack).toHaveBeenCalledOnce();
    });
    // --------------------------------------------------
    it('handler throw results in no XACK when delivery count < 3', async () => {
        const handler = vi.fn().mockRejectedValue(new Error('handler fail'));
        // xpending range call returns delivery count of 1 (not yet DLQ threshold)
        mockRedis.xpending.mockImplementation((...args) => {
            if (args.length === 5)
                return Promise.resolve([['1-0', 'consumer', 100, 1]]);
            return Promise.resolve([0, null, null, null]);
        });
        mockRedis.xreadgroup
            .mockResolvedValueOnce(xreadResult('1-0'))
            .mockResolvedValue(null);
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [handler]]]);
        await driver.start(subs);
        await new Promise((r) => setTimeout(r, 20));
        await driver.stop();
        expect(handler).toHaveBeenCalledOnce();
        expect(mockRedis.xack).not.toHaveBeenCalled();
    });
    // --------------------------------------------------
    it('after 3 delivery attempts moves message to DLQ stream and XACKs', async () => {
        const handler = vi.fn().mockRejectedValue(new Error('handler fail'));
        // xpending range call returns delivery count of 3 → DLQ threshold reached
        mockRedis.xpending.mockImplementation((...args) => {
            if (args.length === 5)
                return Promise.resolve([['1-0', 'consumer', 100, 3]]);
            return Promise.resolve([0, null, null, null]);
        });
        mockRedis.xreadgroup
            .mockResolvedValueOnce(xreadResult('1-0', { entity_id: 'abc' }))
            .mockResolvedValue(null);
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [handler]]]);
        await driver.start(subs);
        await new Promise((r) => setTimeout(r, 20));
        await driver.stop();
        // Should add to DLQ
        const dlqCall = mockRedis.xadd.mock.calls.find((c) => c[0] === 'stream:dlq');
        expect(dlqCall).toBeDefined();
        // Should XACK after DLQ
        expect(mockRedis.xack).toHaveBeenCalledWith('stream:test.event', OPTIONS.consumerGroup, '1-0');
    });
    // --------------------------------------------------
    it('pending count > 1000 logs consumer-lag warning', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // xpending summary returns 1001 pending
        mockRedis.xpending.mockImplementation((...args) => {
            if (args.length === 5)
                return Promise.resolve([]);
            return Promise.resolve([1001, '1-0', '2-0', [['consumer', '1001']]]);
        });
        mockRedis.xreadgroup
            .mockResolvedValueOnce(xreadResult('1-0'))
            .mockResolvedValue(null);
        const handler = vi.fn().mockResolvedValue(undefined);
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [handler]]]);
        await driver.start(subs);
        await new Promise((r) => setTimeout(r, 20));
        await driver.stop();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Consumer lag warning'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1001'));
    });
    // --------------------------------------------------
    it('stop() sets shutdown flag, waits for loops, and calls redis.quit()', async () => {
        const driver = new RedisStreamsDriver(OPTIONS);
        const subs = new Map([['test.event', [vi.fn()]]]);
        await driver.start(subs);
        await driver.stop();
        expect(mockRedis.quit).toHaveBeenCalledOnce();
    });
});
//# sourceMappingURL=redis-streams.test.js.map
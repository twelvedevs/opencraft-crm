import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-sqs before importing the driver
// ---------------------------------------------------------------------------
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', () => ({
    SQSClient: vi.fn(() => ({ send: mockSend })),
    SendMessageCommand: vi.fn((input) => ({ _type: 'SendMessage', input })),
    ReceiveMessageCommand: vi.fn((input) => ({ _type: 'ReceiveMessage', input })),
    DeleteMessageCommand: vi.fn((input) => ({ _type: 'DeleteMessage', input })),
}));
// Import driver AFTER mock is in place
const { EventBridgeDriver } = await import('./eventbridge.js');
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/test.fifo';
const sampleEvent = {
    event_type: 'lead.created',
    entity_type: 'lead',
    entity_id: 'abc-123',
    payload: { name: 'Jane' },
};
function makeDriver() {
    process.env['EVENT_BRIDGE_BUS_NAME'] = 'ortho-bus';
    process.env['SQS_QUEUE_URL'] = QUEUE_URL;
    return new EventBridgeDriver();
}
function sqsMessage(event, receiptHandle = 'rh-1') {
    return { Body: JSON.stringify(event), ReceiptHandle: receiptHandle };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('EventBridgeDriver', () => {
    beforeEach(() => {
        mockSend.mockReset();
        process.env['EVENT_BRIDGE_BUS_NAME'] = 'ortho-bus';
        process.env['SQS_QUEUE_URL'] = QUEUE_URL;
    });
    afterEach(() => {
        delete process.env['EVENT_BRIDGE_BUS_NAME'];
        delete process.env['SQS_QUEUE_URL'];
    });
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    it('throws when EVENT_BRIDGE_BUS_NAME is missing', () => {
        delete process.env['EVENT_BRIDGE_BUS_NAME'];
        expect(() => new EventBridgeDriver()).toThrow('EVENT_BRIDGE_BUS_NAME');
    });
    it('throws when SQS_QUEUE_URL is missing', () => {
        delete process.env['SQS_QUEUE_URL'];
        expect(() => new EventBridgeDriver()).toThrow('SQS_QUEUE_URL');
    });
    // -------------------------------------------------------------------------
    // publish
    // -------------------------------------------------------------------------
    it('publish sends correct MessageBody and MessageGroupId (entity_id)', async () => {
        mockSend.mockResolvedValueOnce({});
        const driver = makeDriver();
        await driver.publish(sampleEvent);
        expect(mockSend).toHaveBeenCalledOnce();
        const [cmd] = mockSend.mock.calls[0];
        expect(cmd._type).toBe('SendMessage');
        expect(cmd.input['QueueUrl']).toBe(QUEUE_URL);
        expect(cmd.input['MessageBody']).toBe(JSON.stringify(sampleEvent));
        expect(cmd.input['MessageGroupId']).toBe(sampleEvent.entity_id);
        expect(typeof cmd.input['MessageDeduplicationId']).toBe('string');
    });
    it('publish falls back to event_type for MessageGroupId when entity_id is absent', async () => {
        mockSend.mockResolvedValueOnce({});
        const driver = makeDriver();
        const event = { event_type: 'system.ping', payload: {} };
        await driver.publish(event);
        const [cmd] = mockSend.mock.calls[0];
        expect(cmd.input['MessageGroupId']).toBe('system.ping');
    });
    // -------------------------------------------------------------------------
    // consume — matching handler
    // -------------------------------------------------------------------------
    it('consume with matching handler calls handler and deletes message', async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        const subscriptions = new Map([['lead.created', [handler]]]);
        // First receive returns the message; second receive returns empty (allows stop)
        mockSend
            .mockResolvedValueOnce({ Messages: [sqsMessage(sampleEvent)] }) // ReceiveMessage
            .mockResolvedValueOnce({}) // DeleteMessage
            .mockResolvedValueOnce({ Messages: [] }); // Second ReceiveMessage (after stop set)
        const driver = makeDriver();
        await driver.start(subscriptions);
        // Give the loop a tick to process the first receive
        await new Promise((r) => setTimeout(r, 10));
        await driver.stop();
        expect(handler).toHaveBeenCalledWith(sampleEvent);
        const deleteCall = mockSend.mock.calls.find((args) => args[0]._type === 'DeleteMessage');
        expect(deleteCall).toBeDefined();
    });
    // -------------------------------------------------------------------------
    // consume — no registered handler
    // -------------------------------------------------------------------------
    it('consume with no registered handler deletes message without calling any handler', async () => {
        const subscriptions = new Map(); // empty
        mockSend
            .mockResolvedValueOnce({ Messages: [sqsMessage(sampleEvent)] })
            .mockResolvedValueOnce({}) // DeleteMessage
            .mockResolvedValueOnce({ Messages: [] });
        const driver = makeDriver();
        await driver.start(subscriptions);
        await new Promise((r) => setTimeout(r, 10));
        await driver.stop();
        const deleteCall = mockSend.mock.calls.find((args) => args[0]._type === 'DeleteMessage');
        expect(deleteCall).toBeDefined();
    });
    // -------------------------------------------------------------------------
    // consume — handler throws
    // -------------------------------------------------------------------------
    it('consume with handler that throws does not delete message', async () => {
        const handler = vi.fn().mockRejectedValue(new Error('handler failed'));
        const subscriptions = new Map([['lead.created', [handler]]]);
        mockSend
            .mockResolvedValueOnce({ Messages: [sqsMessage(sampleEvent)] })
            .mockResolvedValueOnce({ Messages: [] }); // next receive (stop check)
        const driver = makeDriver();
        await driver.start(subscriptions);
        await new Promise((r) => setTimeout(r, 10));
        await driver.stop();
        const deleteCall = mockSend.mock.calls.find((args) => args[0]._type === 'DeleteMessage');
        expect(deleteCall).toBeUndefined();
    });
    // -------------------------------------------------------------------------
    // stop
    // -------------------------------------------------------------------------
    it('stop() causes loop to exit', async () => {
        // Make receive resolve immediately with no messages
        mockSend.mockResolvedValue({ Messages: [] });
        const driver = makeDriver();
        await driver.start(new Map());
        await new Promise((r) => setTimeout(r, 10));
        const receiveCountBeforeStop = mockSend.mock.calls.length;
        await driver.stop();
        // After stop resolves, the loop must have exited
        const receiveCountAfterStop = mockSend.mock.calls.length;
        await new Promise((r) => setTimeout(r, 20));
        // No more calls after stop resolved
        expect(mockSend.mock.calls.length).toBe(receiveCountAfterStop);
        expect(receiveCountBeforeStop).toBeGreaterThanOrEqual(1);
    });
});
//# sourceMappingURL=eventbridge.test.js.map
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
export class EventBridgeDriver {
    client;
    queueUrl;
    shouldStop = false;
    stopResolve = null;
    stoppedPromise = null;
    constructor() {
        const busName = process.env['EVENT_BRIDGE_BUS_NAME'];
        const queueUrl = process.env['SQS_QUEUE_URL'];
        if (!busName)
            throw new Error('EVENT_BRIDGE_BUS_NAME env var is required');
        if (!queueUrl)
            throw new Error('SQS_QUEUE_URL env var is required');
        this.queueUrl = queueUrl;
        this.client = new SQSClient({});
    }
    async publish(event) {
        await this.client.send(new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(event),
            MessageGroupId: event.entity_id ?? event.event_type,
            MessageDeduplicationId: randomUUID(),
        }));
    }
    async start(subscriptions) {
        this.shouldStop = false;
        this.stoppedPromise = new Promise((resolve) => {
            this.stopResolve = resolve;
        });
        void this.pollLoop(subscriptions);
    }
    async stop() {
        this.shouldStop = true;
        await this.stoppedPromise;
    }
    async pollLoop(subscriptions) {
        try {
            while (!this.shouldStop) {
                const result = await this.client.send(new ReceiveMessageCommand({
                    QueueUrl: this.queueUrl,
                    MaxNumberOfMessages: 10,
                    WaitTimeSeconds: 20,
                }));
                const messages = result?.Messages;
                if (!messages?.length) {
                    // Yield to the macrotask queue so timers (e.g. stop signals in tests) can fire.
                    // In production the WaitTimeSeconds long-poll provides natural backoff.
                    await new Promise((r) => setTimeout(r, 0));
                    continue;
                }
                for (const message of messages) {
                    if (!message.Body || !message.ReceiptHandle)
                        continue;
                    let event;
                    try {
                        event = JSON.parse(message.Body);
                    }
                    catch {
                        await this.client.send(new DeleteMessageCommand({
                            QueueUrl: this.queueUrl,
                            ReceiptHandle: message.ReceiptHandle,
                        }));
                        continue;
                    }
                    const handlers = subscriptions.get(event.event_type) ?? [];
                    if (handlers.length === 0) {
                        await this.client.send(new DeleteMessageCommand({
                            QueueUrl: this.queueUrl,
                            ReceiptHandle: message.ReceiptHandle,
                        }));
                        continue;
                    }
                    let failed = false;
                    for (const handler of handlers) {
                        try {
                            await handler(event);
                        }
                        catch {
                            failed = true;
                        }
                    }
                    if (!failed) {
                        await this.client.send(new DeleteMessageCommand({
                            QueueUrl: this.queueUrl,
                            ReceiptHandle: message.ReceiptHandle,
                        }));
                    }
                }
            }
        }
        finally {
            this.stopResolve?.();
        }
    }
}
//# sourceMappingURL=eventbridge.js.map
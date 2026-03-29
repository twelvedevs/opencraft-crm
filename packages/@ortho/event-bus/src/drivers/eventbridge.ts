import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import type { Driver, EventHandler, OrthoEvent } from '../types.js';

export class EventBridgeDriver implements Driver {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  private shouldStop = false;
  private stopResolve: (() => void) | null = null;
  private stoppedPromise: Promise<void> | null = null;

  constructor() {
    const busName = process.env['EVENT_BRIDGE_BUS_NAME'];
    const queueUrl = process.env['SQS_QUEUE_URL'];
    if (!busName) throw new Error('EVENT_BRIDGE_BUS_NAME env var is required');
    if (!queueUrl) throw new Error('SQS_QUEUE_URL env var is required');
    this.queueUrl = queueUrl;
    this.client = new SQSClient({});
  }

  async publish(event: OrthoEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event),
        MessageGroupId: event.entity_id ?? event.event_type,
        MessageDeduplicationId: randomUUID(),
      }),
    );
  }

  async start(subscriptions: Map<string, EventHandler[]>): Promise<void> {
    this.shouldStop = false;
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
    void this.pollLoop(subscriptions);
  }

  async stop(): Promise<void> {
    this.shouldStop = true;
    await this.stoppedPromise;
  }

  private async pollLoop(subscriptions: Map<string, EventHandler[]>): Promise<void> {
    try {
      while (!this.shouldStop) {
        const result = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        );

        const messages = result?.Messages;
        if (!messages?.length) {
          // Yield to the macrotask queue so timers (e.g. stop signals in tests) can fire.
          // In production the WaitTimeSeconds long-poll provides natural backoff.
          await new Promise<void>((r) => setTimeout(r, 0));
          continue;
        }

        for (const message of messages) {
          if (!message.Body || !message.ReceiptHandle) continue;

          let event: OrthoEvent;
          try {
            event = JSON.parse(message.Body) as OrthoEvent;
          } catch {
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
            continue;
          }

          const handlers = subscriptions.get(event.event_type) ?? [];

          if (handlers.length === 0) {
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
            continue;
          }

          let failed = false;
          for (const handler of handlers) {
            try {
              await handler(event);
            } catch {
              failed = true;
            }
          }

          if (!failed) {
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
        }
      }
    } finally {
      this.stopResolve?.();
    }
  }
}

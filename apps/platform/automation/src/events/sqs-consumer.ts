import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

interface SqsConsumerOptions {
  queueUrl: string;
  maxMessages?: number;
  waitSeconds?: number;
  onMessage: (body: string) => Promise<void>;
  logger?: Pick<Console, 'info' | 'error'>;
}

export class SqsConsumer {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly maxMessages: number;
  private readonly waitSeconds: number;
  private readonly onMessage: (body: string) => Promise<void>;
  private readonly logger: Pick<Console, 'info' | 'error'>;
  private running = false;
  private pollDone: Promise<void> = Promise.resolve();

  constructor(options: SqsConsumerOptions) {
    this.queueUrl = options.queueUrl;
    this.maxMessages = options.maxMessages ?? 10;
    this.waitSeconds = options.waitSeconds ?? 20;
    this.onMessage = options.onMessage;
    this.logger = options.logger ?? console;
    this.client = new SQSClient({});
  }

  start(): void {
    this.running = true;
    this.pollDone = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.pollDone;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: this.maxMessages,
          WaitTimeSeconds: this.waitSeconds,
        }),
      );

      for (const message of response.Messages ?? []) {
        try {
          await this.onMessage(message.Body ?? '');
        } catch (err) {
          this.logger.error(err);
        }

        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
  }
}

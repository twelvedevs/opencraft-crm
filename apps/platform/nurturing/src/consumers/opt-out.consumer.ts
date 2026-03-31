import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { NurturingPublisher } from '../events/publisher.js';
import type { UnenrollParams, UnenrollResult, UnenrollmentDeps } from '../services/unenrollment.js';
import { unenroll } from '../services/unenrollment.js';
import type { Logger } from 'pino';

export interface OptOutConsumerDeps {
  sqsClient: SQSClient;
  queueUrl: string;
  enrollmentsRepo: EnrollmentsRepository;
  unenroll: (params: UnenrollParams, deps: UnenrollmentDeps) => Promise<UnenrollResult>;
  unenrollDeps: UnenrollmentDeps;
  publisher: NurturingPublisher;
  logger: Logger;
}

export async function processOptOutMessage(messageBody: string, deps: OptOutConsumerDeps): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageBody);
  } catch {
    deps.logger.warn({ body: messageBody }, 'opt_out.received: malformed event, skipping');
    return;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('detail' in parsed) ||
    typeof (parsed as Record<string, unknown>).detail !== 'object' ||
    (parsed as Record<string, unknown>).detail === null ||
    typeof ((parsed as Record<string, unknown>).detail as Record<string, unknown>).entity_id !== 'string'
  ) {
    deps.logger.warn({ body: messageBody }, 'opt_out.received: malformed event, skipping');
    return;
  }

  const entityId = ((parsed as Record<string, unknown>).detail as Record<string, unknown>).entity_id as string;

  const enrollments = await deps.enrollmentsRepo.findAllActiveByEntityId(entityId);

  for (const enrollment of enrollments) {
    await deps.unenroll(
      {
        sequence_id: enrollment.sequence_id,
        entity_type: enrollment.entity_type,
        entity_id: enrollment.entity_id,
      },
      deps.unenrollDeps,
    );
  }

  await deps.publisher.publishAllSequencesCancelled({
    entity_type: enrollments[0]?.entity_type ?? 'unknown',
    entity_id: entityId,
    cancelled_count: enrollments.length,
  });
}

export function startOptOutConsumer(deps: OptOutConsumerDeps): () => void {
  const { sqsClient, queueUrl } = deps;

  const timer = setInterval(() => {
    void (async () => {
      let messages: { Body?: string; ReceiptHandle?: string }[] = [];
      try {
        const result = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        );
        messages = result.Messages ?? [];
      } catch (err) {
        deps.logger.error(err, 'opt_out consumer: failed to receive messages from SQS');
        return;
      }

      for (const message of messages) {
        try {
          await processOptOutMessage(message.Body!, deps);
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle!,
            }),
          );
        } catch (err) {
          deps.logger.error(err, 'opt_out consumer: failed to process message, leaving in queue for retry');
        }
      }
    })();
  }, 10_000);

  return () => clearInterval(timer);
}

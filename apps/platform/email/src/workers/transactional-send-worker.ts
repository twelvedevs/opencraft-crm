import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Knex } from '../db.js';
import type { EventBus } from '@ortho/event-bus';
import { EmailSendsRepository } from '../repositories/email-sends-repository.js';
import { DomainRepository } from '../repositories/domain-repository.js';
import { env } from '../env.js';

interface TransactionalSendJobData {
  emailSendId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function createTransactionalSendWorker(
  connection: Redis,
  db: Knex,
  eventBus: EventBus,
): Worker {
  const repo = new EmailSendsRepository(db);
  const domainRepo = new DomainRepository(db);

  const worker = new Worker<TransactionalSendJobData>(
    'transactional-send',
    async (job) => {
      const send = await repo.findById(job.data.emailSendId);
      if (!send) return;

      // Crash recovery guard: if sendgrid_message_id is already set, a previous
      // attempt succeeded but crashed before DB update — skip to avoid double-send
      if (send.sendgrid_message_id !== null) return;

      await repo.incrementAttempt(send.id);

      const domain = await domainRepo.findById(send.domain_id!);

      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: job.data.to }] }],
          from: { email: domain?.from_email, name: domain?.from_name },
          subject: job.data.subject,
          content: [
            { type: 'text/html', value: job.data.html },
            { type: 'text/plain', value: job.data.text },
          ],
        }),
      });

      if (response.status === 202) {
        const sendgridMessageId = response.headers.get('X-Message-Id') ?? '';
        await repo.markSent(send.id, sendgridMessageId);
        await eventBus.publish({
          event_type: 'email.sent',
          entity_type: send.entity_type ?? undefined,
          entity_id: send.entity_id ?? undefined,
          payload: {
            email_id: send.id,
            to_email: send.to_email,
            location_id: send.location_id,
            sendgrid_message_id: sendgridMessageId,
          },
        });
        return;
      }

      throw new Error(`SendGrid responded with ${response.status}`);
    },
    {
      connection,
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number) => {
          const delays = [5000, 30000, 120_000, 600_000];
          return delays[attemptsMade - 1] ?? 600_000;
        },
      },
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const send = await repo.findById(job.data.emailSendId);
      await repo.markFailed(job.data.emailSendId, err.message);
      await eventBus.publish({
        event_type: 'email.failed',
        entity_type: send?.entity_type ?? undefined,
        entity_id: send?.entity_id ?? undefined,
        payload: {
          email_id: job.data.emailSendId,
          to_email: job.data.to,
          error: err.message,
        },
      });
    }
  });

  return worker;
}

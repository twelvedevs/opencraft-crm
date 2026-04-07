import { Worker } from 'bullmq';
import type { Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import * as scheduledRepo from '../repositories/scheduled.repo.js';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as messagesRepo from '../repositories/messages.repo.js';
import { messagingClient } from '../lib/service-client.js';
import { env } from '../env.js';

const logger = createLogger('crm-conversation');

export function createScheduledSendWorker(db: Knex): Worker {
  return new Worker(
    'conversation:scheduled-send',
    async (job) => {
      const { scheduled_message_id } = job.data as { scheduled_message_id: string };
      const log = logger.child({ jobId: job.id, scheduledMessageId: scheduled_message_id });

      const scheduled = await scheduledRepo.findById(db, scheduled_message_id);
      if (!scheduled) {
        log.warn('Scheduled message not found, skipping');
        return;
      }

      // Idempotency guard — already sent or cancelled
      if (scheduled.status !== 'pending') {
        log.debug({ status: scheduled.status }, 'Scheduled message not pending, skipping');
        return;
      }

      const conversation = await conversationsRepo.findById(db, scheduled.conversation_id);
      if (!conversation) {
        log.error('Conversation not found for scheduled message');
        return;
      }

      // Send via Messaging Service
      const response = await messagingClient.post<{ message_id: string }>(
        '/messages/send',
        {
          to: conversation.lead_phone,
          from_number: conversation.practice_number,
          body: scheduled.body,
          dedup_key: `sched:${scheduled_message_id}`,
        },
      );

      // Insert conversation message
      await messagesRepo.insert(db, {
        conversation_id: conversation.id,
        direction: 'outbound',
        author_id: scheduled.created_by,
        body: scheduled.body,
        status: 'queued',
        messaging_message_id: response.message_id,
      });

      // Mark scheduled message as sent
      await scheduledRepo.updateStatus(db, scheduled_message_id, 'sent', new Date());

      // Update conversation last_message_at
      await conversationsRepo.update(db, conversation.id, {
        last_message_at: new Date(),
      });

      log.info('Scheduled message sent successfully');
    },
    {
      connection: { url: env.BULLMQ_REDIS_URL },
      concurrency: env.SCHEDULED_SEND_CONCURRENCY,
    },
  );
}

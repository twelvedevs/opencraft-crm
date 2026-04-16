import { Worker } from 'bullmq';
import type { Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as messagesRepo from '../repositories/messages.repo.js';
import * as settingsRepo from '../repositories/settings.repo.js';
import { aiClient, leadClient, messagingClient, notificationClient } from '../lib/service-client.js';
import { buildDisclosureFooter, parseAgentResponse } from '../services/agent-mode.js';
import { env } from '../env.js';

const logger = createLogger('crm-conversation');

export function createAiAgentReplyWorker(db: Knex): Worker {
  return new Worker(
    'conversation-ai-agent-reply',
    async (job) => {
      const { conversation_id, trigger_message_id } = job.data as {
        conversation_id: string;
        trigger_message_id: string;
      };
      const log = logger.child({ jobId: job.id, conversationId: conversation_id });

      const conversation = await conversationsRepo.findById(db, conversation_id);
      if (!conversation) {
        log.warn('Conversation not found, skipping');
        return;
      }

      const messages = await messagesRepo.listByConversation(db, conversation_id, { limit: 10 });
      const settings = await settingsRepo.getEffectiveSettings(db, conversation.location_id);

      const lead = await leadClient.get<{
        id: string;
        name: string;
        current_stage: string;
        treatment_interest: string;
      }>(`/leads/${conversation.lead_id}`);

      const response = await aiClient.post<{ text: string }>('/ai/complete', {
        prompt_id: 'conversation-agent-reply',
        context: {
          lead_name: lead.name,
          lead_stage: lead.current_stage,
          treatment_interest: lead.treatment_interest,
          location_phone: settings.location_phone,
          recent_messages: messages.map((m) => ({
            direction: m.direction,
            body: m.body,
            created_at: m.created_at,
          })),
        },
      });

      const parsed = parseAgentResponse(response.text);

      // Escalate on parse failure or explicit escalation
      if (!parsed || parsed.escalate) {
        await conversationsRepo.update(db, conversation.id, {
          escalated: true,
          agent_mode_active: false,
        });

        try {
          await notificationClient.post('/notifications/publish', {
            channel: `location:${conversation.location_id}:conversations`,
            payload: {
              type: 'agent_escalation',
              conversation_id: conversation.id,
            },
          });
        } catch (err) {
          log.warn({ err }, 'Failed to send escalation notification');
        }

        log.info(
          { reason: parsed?.reason ?? 'parse_failure' },
          'AI agent escalated conversation',
        );
        return;
      }

      // Non-escalate: send automated reply
      const fullBody = parsed.text + '\n\n' + buildDisclosureFooter(settings.location_phone!);
      const dedupKey = `agent:${conversation_id}:${conversation.agent_exchange_count}`;

      const msgResponse = await messagingClient.post<{ message_id: string }>(
        '/messages/send',
        {
          to: conversation.lead_phone,
          from_number: conversation.practice_number,
          body: fullBody,
          dedup_key: dedupKey,
        },
      );

      await messagesRepo.insert(db, {
        conversation_id: conversation.id,
        direction: 'outbound',
        is_agent: true,
        is_automated: false,
        status: 'queued',
        messaging_message_id: msgResponse.message_id,
        body: fullBody,
      });

      await conversationsRepo.update(db, conversation.id, {
        agent_exchange_count: conversation.agent_exchange_count + 1,
        last_message_at: new Date(),
      });

      log.info('AI agent reply sent successfully');
    },
    {
      connection: { url: env.BULLMQ_REDIS_URL },
      concurrency: env.AI_AGENT_CONCURRENCY,
    },
  );
}

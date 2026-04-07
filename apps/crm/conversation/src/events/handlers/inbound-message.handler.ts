import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { resolveConversation } from '../../services/conversation-resolver.js';
import * as messagesRepo from '../../repositories/messages.repo.js';
import * as conversationsRepo from '../../repositories/conversations.repo.js';
import { getEffectiveSettings } from '../../repositories/settings.repo.js';
import { publishMessageReceived } from '../publisher.js';
import { leadClient, notificationClient } from '../../lib/service-client.js';

const log = createLogger('crm-conversation');

interface LeadLookupResult {
  id: string;
  location_id: string;
  phone: string;
  current_stage?: string;
  treatment_interest?: string;
  name?: string;
}

export async function handleInboundMessage(
  db: Knex,
  bus: EventBus,
  queues: { aiAgentQueue: Queue },
  event: OrthoEvent,
): Promise<void> {
  const payload = event.payload as {
    from_number: string;
    to_number: string;
    body: string;
    message_type: 'normal' | 'stop' | 'unstop';
    message_id: string;
    received_at: string;
  };

  // Look up lead by phone number
  let lead: LeadLookupResult;
  try {
    lead = await leadClient.get<LeadLookupResult>('/leads', {
      phone: payload.from_number,
    });
  } catch {
    log.warn({ from_number: payload.from_number }, 'unknown number, skipping');
    return;
  }

  // Find or create conversation
  const conversation = await resolveConversation(db, {
    leadId: lead.id,
    locationId: lead.location_id,
    practiceNumber: payload.to_number,
    leadPhone: payload.from_number,
  });

  // Insert inbound message
  const insertedMessage = await messagesRepo.insert(db, {
    conversation_id: conversation.id,
    direction: 'inbound',
    body: payload.body,
    message_type: payload.message_type,
    status: 'received',
    messaging_message_id: payload.message_id,
    received_at: new Date(payload.received_at),
  });

  // Update conversation last_message_at
  await conversationsRepo.update(db, conversation.id, {
    last_message_at: new Date(),
  });

  // Publish message.received event
  await publishMessageReceived(bus, {
    correlationId: event.correlation_id ?? '',
    causationId: event.event_id ?? '',
    payload: {
      entity_type: 'lead',
      entity_id: lead.id,
      message_id: insertedMessage.id,
      conversation_id: conversation.id,
      lead_id: lead.id,
      location_id: lead.location_id,
      body: payload.body,
      message_type: payload.message_type,
      from_number: payload.from_number,
      practice_number: payload.to_number,
      received_at: payload.received_at,
    },
  });

  // Send in-app notification
  try {
    await notificationClient.post('/notifications/publish', {
      channel: `location:${lead.location_id}:conversations`,
      payload: {
        type: 'inbound_message',
        conversation_id: conversation.id,
        lead_id: lead.id,
        preview: payload.body.slice(0, 80),
      },
    });
  } catch (err) {
    log.warn({ err, conversation_id: conversation.id }, 'failed to send inbound notification');
  }

  // Skip AI agent for STOP/UNSTOP messages
  if (payload.message_type !== 'normal') {
    return;
  }

  // AI agent logic
  const settings = await getEffectiveSettings(db, lead.location_id);

  if (
    settings.agent_mode_enabled &&
    conversation.agent_mode_active &&
    conversation.assigned_to === null &&
    !conversation.escalated
  ) {
    if (conversation.agent_exchange_count >= settings.agent_max_exchanges) {
      // Escalate — max exchanges reached
      await conversationsRepo.update(db, conversation.id, {
        escalated: true,
      });

      try {
        await notificationClient.post('/notifications/publish', {
          channel: `location:${lead.location_id}:conversations`,
          payload: {
            type: 'agent_escalation',
            conversation_id: conversation.id,
          },
        });
      } catch (err) {
        log.warn({ err, conversation_id: conversation.id }, 'failed to send escalation notification');
      }
    } else {
      // Enqueue AI agent reply job
      await queues.aiAgentQueue.add('ai-agent-reply', {
        conversation_id: conversation.id,
        trigger_message_id: insertedMessage.id,
      });
    }
  }
}

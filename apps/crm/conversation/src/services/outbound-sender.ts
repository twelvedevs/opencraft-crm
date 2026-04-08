import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as messagesRepo from '../repositories/messages.repo.js';
import { messagingClient } from '../lib/service-client.js';

export async function sendOutbound(
  db: Knex,
  opts: {
    conversationId: string;
    body: string;
    mediaUrl?: string;
    authorId: string;
  },
): Promise<{ messageId: string; status: string }> {
  const conversation = await conversationsRepo.findById(db, opts.conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${opts.conversationId}`);
  }

  // Disable agent mode if active
  if (conversation.agent_mode_active) {
    await conversationsRepo.update(db, conversation.id, {
      agent_mode_active: false,
    });
  }

  // Send via Messaging Service
  const response = await messagingClient.post<{ message_id: string }>(
    '/messages/send',
    {
      to: conversation.lead_phone,
      from_number: conversation.practice_number,
      body: opts.body,
      dedup_key: randomUUID(),
    },
  );

  // Store outbound message
  const message = await messagesRepo.insert(db, {
    conversation_id: conversation.id,
    direction: 'outbound',
    author_id: opts.authorId,
    body: opts.body,
    status: 'queued',
    messaging_message_id: response.message_id,
  });

  // Update last_message_at
  await conversationsRepo.update(db, conversation.id, {
    last_message_at: new Date(),
  });

  return { messageId: message.id, status: 'queued' };
}

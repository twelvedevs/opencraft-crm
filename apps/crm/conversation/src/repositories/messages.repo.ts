import type { Knex } from 'knex';

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  direction: string;
  author_id: string | null;
  body: string | null;
  media_urls: string[] | null;
  message_type: string;
  status: string;
  is_automated: boolean;
  is_agent: boolean;
  messaging_message_id: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  received_at: Date | null;
  created_at: Date;
}

const TABLE = 'conversation_messages';

export async function insert(
  db: Knex,
  data: {
    conversation_id: string;
    direction: string;
    author_id?: string | null;
    body?: string | null;
    media_urls?: string[] | null;
    message_type?: string;
    status: string;
    is_automated?: boolean;
    is_agent?: boolean;
    messaging_message_id?: string | null;
    sent_at?: Date | null;
    received_at?: Date | null;
  },
): Promise<ConversationMessage> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as ConversationMessage;
}

export async function updateStatus(
  db: Knex,
  messagingMessageId: string,
  update: { status: string; delivered_at?: Date },
): Promise<number> {
  return db(TABLE)
    .where('messaging_message_id', messagingMessageId)
    .update(update);
}

export async function listByConversation(
  db: Knex,
  conversationId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<ConversationMessage[]> {
  const limit = opts.limit ?? 50;

  let query = db(TABLE)
    .where('conversation_id', conversationId)
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (opts.before) {
    const cursor = await db(TABLE).where('id', opts.before).select('created_at').first();
    if (cursor) {
      query = query.where('created_at', '<', cursor.created_at);
    }
  }

  return query as Promise<ConversationMessage[]>;
}

export async function getLatestMessageId(
  db: Knex,
  conversationId: string,
): Promise<string | null> {
  const row = await db(TABLE)
    .where('conversation_id', conversationId)
    .orderBy('created_at', 'desc')
    .select('id')
    .first();
  return row?.id ?? null;
}

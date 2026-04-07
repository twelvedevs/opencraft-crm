import type { Knex } from 'knex';

export interface ConversationRead {
  conversation_id: string;
  user_id: string;
  last_read_message_id: string | null;
  read_at: Date;
}

const TABLE = 'conversation_reads';

export async function upsert(
  db: Knex,
  conversationId: string,
  userId: string,
  lastReadMessageId: string,
): Promise<void> {
  await db.raw(
    `INSERT INTO ${TABLE} (conversation_id, user_id, last_read_message_id, read_at)
     VALUES (?, ?, ?, now())
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id, read_at = now()`,
    [conversationId, userId, lastReadMessageId],
  );
}

export async function getUnreadCount(
  db: Knex,
  conversationId: string,
  userId: string,
): Promise<number> {
  const readRecord = await db(TABLE)
    .where({ conversation_id: conversationId, user_id: userId })
    .first() as ConversationRead | undefined;

  if (!readRecord?.last_read_message_id) {
    // No read record — all messages are unread
    const [{ count }] = await db('conversation_messages')
      .where('conversation_id', conversationId)
      .count('* as count');
    return Number(count);
  }

  // Count messages created after the last read message
  const cursor = await db('conversation_messages')
    .where('id', readRecord.last_read_message_id)
    .select('created_at')
    .first();

  if (!cursor) {
    // Last read message was deleted — count all
    const [{ count }] = await db('conversation_messages')
      .where('conversation_id', conversationId)
      .count('* as count');
    return Number(count);
  }

  const [{ count }] = await db('conversation_messages')
    .where('conversation_id', conversationId)
    .where('created_at', '>', cursor.created_at)
    .count('* as count');
  return Number(count);
}

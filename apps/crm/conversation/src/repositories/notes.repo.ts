import type { Knex } from 'knex';

export interface ConversationNote {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  created_at: Date;
}

const TABLE = 'conversation_notes';

export async function create(
  db: Knex,
  data: {
    conversation_id: string;
    author_id: string;
    body: string;
  },
): Promise<ConversationNote> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as ConversationNote;
}

export async function deleteById(
  db: Knex,
  id: string,
  conversationId: string,
): Promise<boolean> {
  const count = await db(TABLE)
    .where({ id, conversation_id: conversationId })
    .delete();
  return count > 0;
}

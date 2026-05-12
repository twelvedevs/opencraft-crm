import type { Knex } from 'knex';

export interface Conversation {
  id: string;
  lead_id: string;
  location_id: string;
  practice_number: string;
  lead_phone: string;
  status: string;
  assigned_to: string | null;
  escalated: boolean;
  agent_mode_active: boolean;
  agent_exchange_count: number;
  last_message_at: Date | null;
  created_at: Date;
}

export interface ConversationListRow extends Conversation {
  unread_count: number;
  last_message_preview: string | null;
}

const TABLE = 'conversations';

export async function findById(db: Knex, id: string): Promise<Conversation | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as Conversation) ?? null;
}

export async function findRecent(
  db: Knex,
  leadId: string,
  practiceNumber: string,
  afterTimestamp: Date,
): Promise<Conversation | null> {
  const row = await db(TABLE)
    .where('lead_id', leadId)
    .where('practice_number', practiceNumber)
    .where('last_message_at', '>', afterTimestamp)
    .orderBy('last_message_at', 'desc')
    .first();
  return (row as Conversation) ?? null;
}

export async function create(
  db: Knex,
  data: {
    lead_id: string;
    location_id: string;
    practice_number: string;
    lead_phone: string;
  },
): Promise<Conversation> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as Conversation;
}

export async function update(
  db: Knex,
  id: string,
  data: Partial<{
    assigned_to: string | null;
    escalated: boolean;
    status: string;
    agent_mode_active: boolean;
    agent_exchange_count: number;
    last_message_at: Date;
  }>,
): Promise<Conversation> {
  const [row] = await db(TABLE).where({ id }).update(data).returning('*');
  return row as Conversation;
}

export async function list(
  db: Knex,
  filters: {
    location_id: string;
    lead_id?: string;
    status?: string;
    assigned_to?: string;
    page?: number;
    limit?: number;
    user_id?: string;
  },
): Promise<{ rows: ConversationListRow[]; total: number }> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  // Count query
  let countQuery = db(TABLE).where('location_id', filters.location_id);
  if (filters.lead_id) countQuery = countQuery.where('lead_id', filters.lead_id);
  if (filters.status) countQuery = countQuery.where('status', filters.status);
  if (filters.assigned_to) countQuery = countQuery.where('assigned_to', filters.assigned_to);

  const [{ count }] = await countQuery.count('* as count');
  const total = Number(count);

  // Main query with subqueries for unread_count and last_message_preview
  let query = db(TABLE)
    .select(
      `${TABLE}.*`,
      db.raw(`(
        SELECT LEFT(body, 80) FROM conversation_messages
        WHERE conversation_id = ${TABLE}.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS last_message_preview`),
      db.raw(`(
        SELECT COUNT(*)::int FROM conversation_messages cm
        WHERE cm.conversation_id = ${TABLE}.id
        AND (
          NOT EXISTS (
            SELECT 1 FROM conversation_reads cr
            WHERE cr.conversation_id = ${TABLE}.id
            AND cr.user_id = ?
          )
          OR cm.created_at > (
            SELECT cm2.created_at FROM conversation_messages cm2
            JOIN conversation_reads cr2 ON cr2.last_read_message_id = cm2.id
            WHERE cr2.conversation_id = ${TABLE}.id
            AND cr2.user_id = ?
            LIMIT 1
          )
        )
      ) AS unread_count`, [filters.user_id ?? '00000000-0000-0000-0000-000000000000', filters.user_id ?? '00000000-0000-0000-0000-000000000000']),
    )
    .where(`${TABLE}.location_id`, filters.location_id);

  if (filters.lead_id) query = query.where(`${TABLE}.lead_id`, filters.lead_id);
  if (filters.status) query = query.where(`${TABLE}.status`, filters.status);
  if (filters.assigned_to) query = query.where(`${TABLE}.assigned_to`, filters.assigned_to);

  const rows = await query
    .orderBy(`${TABLE}.last_message_at`, 'desc')
    .limit(limit)
    .offset(offset);

  return { rows: rows as ConversationListRow[], total };
}

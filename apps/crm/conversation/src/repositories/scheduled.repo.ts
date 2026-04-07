import type { Knex } from 'knex';

export interface ScheduledMessage {
  id: string;
  conversation_id: string;
  body: string;
  media_url: string | null;
  scheduled_for: Date;
  status: string;
  created_by: string;
  bullmq_job_id: string | null;
  sent_at: Date | null;
  created_at: Date;
}

const TABLE = 'scheduled_messages';

export async function create(
  db: Knex,
  data: {
    conversation_id: string;
    body: string;
    media_url?: string | null;
    scheduled_for: Date;
    created_by: string;
  },
): Promise<ScheduledMessage> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as ScheduledMessage;
}

export async function updateBullmqJobId(
  db: Knex,
  id: string,
  bullmqJobId: string,
): Promise<void> {
  await db(TABLE).where({ id }).update({ bullmq_job_id: bullmqJobId });
}

export async function findById(
  db: Knex,
  id: string,
): Promise<ScheduledMessage | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as ScheduledMessage) ?? null;
}

export async function updateStatus(
  db: Knex,
  id: string,
  status: 'sent' | 'cancelled',
  sentAt?: Date,
): Promise<ScheduledMessage> {
  const updateData: Record<string, unknown> = { status };
  if (sentAt) {
    updateData.sent_at = sentAt;
  }
  const [row] = await db(TABLE).where({ id }).update(updateData).returning('*');
  return row as ScheduledMessage;
}

export async function listPending(
  db: Knex,
  conversationId: string,
): Promise<ScheduledMessage[]> {
  return db(TABLE)
    .where({ conversation_id: conversationId, status: 'pending' })
    .orderBy('scheduled_for', 'asc') as Promise<ScheduledMessage[]>;
}

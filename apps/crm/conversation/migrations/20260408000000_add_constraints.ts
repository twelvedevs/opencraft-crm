import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add CHECK constraint on conversation_messages.status
  // (all other status columns in the schema are constrained; this one was missed)
  await knex.raw(`
    ALTER TABLE crm_conversations.conversation_messages
    ADD CONSTRAINT conversation_messages_status_check
    CHECK (status IN ('queued','sent','delivered','failed','received'))
  `);

  // Add FK constraint on conversation_reads.conversation_id
  // (conversation_notes, conversation_messages, and scheduled_messages all have FKs;
  //  conversation_reads was missing it, allowing orphaned read records)
  await knex.raw(`
    ALTER TABLE crm_conversations.conversation_reads
    ADD CONSTRAINT conversation_reads_conversation_id_fkey
    FOREIGN KEY (conversation_id)
    REFERENCES crm_conversations.conversations(id)
    ON DELETE CASCADE
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE crm_conversations.conversation_reads
    DROP CONSTRAINT IF EXISTS conversation_reads_conversation_id_fkey
  `);

  await knex.raw(`
    ALTER TABLE crm_conversations.conversation_messages
    DROP CONSTRAINT IF EXISTS conversation_messages_status_check
  `);
}

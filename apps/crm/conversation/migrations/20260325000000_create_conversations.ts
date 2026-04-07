import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS crm_conversations');

  // conversations
  await knex.schema.withSchema('crm_conversations').createTable('conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('lead_id').notNullable();
    table.uuid('location_id').notNullable();
    table.text('practice_number').notNullable();
    table.text('lead_phone').notNullable();
    table.text('status').notNullable().defaultTo('open');
    table.uuid('assigned_to').nullable();
    table.boolean('escalated').notNullable().defaultTo(false);
    table.boolean('agent_mode_active').notNullable().defaultTo(false);
    table.integer('agent_exchange_count').notNullable().defaultTo(0);
    table.timestamp('last_message_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_conversations.conversations
    ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('open','closed'))
  `);

  // conversation_messages
  await knex.schema.withSchema('crm_conversations').createTable('conversation_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('crm_conversations.conversations');
    table.text('direction').notNullable();
    table.uuid('author_id').nullable();
    table.text('body').nullable();
    table.specificType('media_urls', 'text[]').nullable();
    table.text('message_type').notNullable().defaultTo('normal');
    table.text('status').notNullable();
    table.boolean('is_automated').notNullable().defaultTo(false);
    table.boolean('is_agent').notNullable().defaultTo(false);
    table.uuid('messaging_message_id').nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('delivered_at', { useTz: true }).nullable();
    table.timestamp('received_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_conversations.conversation_messages
    ADD CONSTRAINT conversation_messages_direction_check
    CHECK (direction IN ('inbound','outbound'))
  `);

  await knex.raw(`
    ALTER TABLE crm_conversations.conversation_messages
    ADD CONSTRAINT conversation_messages_message_type_check
    CHECK (message_type IN ('normal','stop','unstop'))
  `);

  // conversation_notes
  await knex.schema.withSchema('crm_conversations').createTable('conversation_notes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('crm_conversations.conversations');
    table.uuid('author_id').notNullable();
    table.text('body').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // conversation_reads
  await knex.schema.withSchema('crm_conversations').createTable('conversation_reads', (table) => {
    table.uuid('conversation_id').notNullable();
    table.uuid('user_id').notNullable();
    table.uuid('last_read_message_id').nullable();
    table.timestamp('read_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(['conversation_id', 'user_id']);
  });

  // scheduled_messages
  await knex.schema.withSchema('crm_conversations').createTable('scheduled_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('crm_conversations.conversations');
    table.text('body').notNullable();
    table.text('media_url').nullable();
    table.timestamp('scheduled_for', { useTz: true }).notNullable();
    table.text('status').notNullable().defaultTo('pending');
    table.uuid('created_by').notNullable();
    table.text('bullmq_job_id').nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_conversations.scheduled_messages
    ADD CONSTRAINT scheduled_messages_status_check
    CHECK (status IN ('pending','sent','cancelled'))
  `);

  // location_conversation_settings
  await knex.schema.withSchema('crm_conversations').createTable('location_conversation_settings', (table) => {
    table.uuid('location_id').primary();
    table.integer('inactivity_days').notNullable().defaultTo(30);
    table.boolean('agent_mode_enabled').notNullable().defaultTo(false);
    table.integer('agent_max_exchanges').notNullable().defaultTo(3);
    table.text('location_phone').nullable();
    table.text('practice_number').nullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_conversations.location_conversation_settings
    ADD CONSTRAINT location_settings_agent_mode_check
    CHECK (agent_mode_enabled = false OR (location_phone IS NOT NULL AND practice_number IS NOT NULL))
  `);

  // bulk_send_jobs
  await knex.schema.withSchema('crm_conversations').createTable('bulk_send_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('location_id').notNullable();
    table.jsonb('segment').notNullable();
    table.text('body').notNullable();
    table.text('status').notNullable().defaultTo('pending');
    table.integer('total').nullable();
    table.integer('sent').notNullable().defaultTo(0);
    table.integer('failed').notNullable().defaultTo(0);
    table.uuid('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true }).nullable();
  });

  await knex.raw(`
    ALTER TABLE crm_conversations.bulk_send_jobs
    ADD CONSTRAINT bulk_send_jobs_status_check
    CHECK (status IN ('pending','processing','completed','failed'))
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX conversations_location_status_last_msg_idx
    ON crm_conversations.conversations (location_id, status, last_message_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX conversations_lead_practice_last_msg_idx
    ON crm_conversations.conversations (lead_id, practice_number, last_message_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX conversation_messages_conversation_created_idx
    ON crm_conversations.conversation_messages (conversation_id, created_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX conversation_messages_messaging_message_id_idx
    ON crm_conversations.conversation_messages (messaging_message_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP SCHEMA IF EXISTS crm_conversations CASCADE');
}

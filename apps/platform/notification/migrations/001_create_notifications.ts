import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_notifications');

  await knex.schema.withSchema('platform_notifications').createTable('notifications', (table) => {
    table.uuid('id').primary();
    table.specificType('seq', 'bigserial').notNullable().unique();
    table.text('channel').notNullable();
    table.text('title').notNullable();
    table.text('body').nullable();
    table.jsonb('payload').nullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Index on (channel, created_at DESC, id DESC) for history queries
  await knex.raw(`
    CREATE INDEX notifications_channel_created_at_id_idx
    ON platform_notifications.notifications (channel, created_at DESC, id DESC)
  `);

  // Index on (channel, seq) for replay/missed queries
  await knex.raw(`
    CREATE INDEX notifications_channel_seq_idx
    ON platform_notifications.notifications (channel, seq)
  `);

  // Index on expires_at for cleanup worker
  await knex.raw(`
    CREATE INDEX notifications_expires_at_idx
    ON platform_notifications.notifications (expires_at)
  `);

  await knex.schema.withSchema('platform_notifications').createTable('notification_reads', (table) => {
    table.uuid('user_id').notNullable();
    table
      .uuid('notification_id')
      .notNullable()
      .references('id')
      .inTable('platform_notifications.notifications')
      .onDelete('CASCADE');
    table.timestamp('read_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(['user_id', 'notification_id']);
  });

  // Index on notification_id for JOIN queries
  await knex.raw(`
    CREATE INDEX notification_reads_notification_id_idx
    ON platform_notifications.notification_reads (notification_id)
  `);

  // Partial index on (user_id, notification_id) WHERE read_at IS NOT NULL
  await knex.raw(`
    CREATE INDEX notification_reads_user_id_notification_id_read_idx
    ON platform_notifications.notification_reads (user_id, notification_id)
    WHERE read_at IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_notifications').dropTableIfExists('notification_reads');
  await knex.schema.withSchema('platform_notifications').dropTableIfExists('notifications');
}

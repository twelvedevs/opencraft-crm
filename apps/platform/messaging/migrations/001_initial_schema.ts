import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('messaging_numbers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('location_id').notNullable();
    table.text('channel').notNullable();
    table.text('phone_number').notNullable().unique();
    table.text('friendly_name').nullable();
    table.boolean('active').notNullable().defaultTo(true);
    table.integer('rate_limit_mps').notNullable().defaultTo(3);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['location_id', 'channel']);
  });

  await knex.schema.createTable('messaging_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('direction').notNullable();
    table.text('to_number').notNullable();
    table.text('from_number').notNullable();
    table.text('body').nullable();
    table.specificType('media_urls', 'text[]');
    table.text('message_type').notNullable().defaultTo('normal');
    table.text('status').notNullable();
    table.text('twilio_sid').unique().nullable();
    table.text('dedup_key').unique().nullable();
    table.text('error_code').nullable();
    table.text('error_message').nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('delivered_at', { useTz: true }).nullable();
    table.timestamp('received_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['to_number', 'created_at']);
    table.index(['from_number', 'created_at']);
    table.index(['status', 'created_at']);
  });

  await knex.schema.createTable('messaging_opt_outs', (table) => {
    table.text('phone_number').primary();
    table.timestamp('opted_out_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('source').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('messaging_opt_outs');
  await knex.schema.dropTableIfExists('messaging_messages');
  await knex.schema.dropTableIfExists('messaging_numbers');
}

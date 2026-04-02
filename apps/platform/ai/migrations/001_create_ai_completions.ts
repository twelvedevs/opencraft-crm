import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_ai');

  await knex.schema.withSchema('platform_ai').createTable('ai_completions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('cache_key').notNullable().unique();
    table.text('prompt_id').notNullable();
    table.text('model').notNullable();
    table.text('response_text').notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX ai_completions_expires_at_idx
    ON platform_ai.ai_completions (expires_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_ai').dropTableIfExists('ai_completions');
}

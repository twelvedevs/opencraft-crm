import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_sending_domains', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('location_id').notNullable().unique();
    table.text('domain').notNullable();
    table.text('from_name').notNullable();
    table.text('from_email').notNullable();
    table.boolean('is_verified').notNullable().defaultTo(false);
    table.specificType('spam_score_threshold', 'numeric').notNullable().defaultTo(5.0);
    table.text('sendgrid_domain_id').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('email_sends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('dedup_key').unique().nullable();
    table.text('location_id').notNullable();
    table.uuid('domain_id').references('id').inTable('email_sending_domains').nullable();
    table.text('entity_type').nullable();
    table.text('entity_id').nullable();
    table.text('to_email').notNullable();
    table.text('subject').notNullable();
    table.text('sendgrid_message_id').nullable();
    table.text('status').notNullable().defaultTo('queued');
    table.integer('attempt').notNullable().defaultTo(0);
    table.text('error').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('delivered_at', { useTz: true }).nullable();
    table.timestamp('bounced_at', { useTz: true }).nullable();

    table.index(['sendgrid_message_id']);
    table.index(['status']);
    table.index(['domain_id', 'created_at']);
  });

  await knex.schema.createTable('email_campaign_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('job_ref').unique().nullable();
    table.text('location_id').notNullable();
    table.text('entity_type').nullable();
    table.text('entity_id').nullable();
    table.text('template_id').notNullable();
    table.text('subject_template').notNullable();
    table.uuid('domain_id').references('id').inTable('email_sending_domains').notNullable();
    table.timestamp('scheduled_for', { useTz: true }).nullable();
    table.specificType('spam_score', 'numeric').nullable();
    table.jsonb('spam_issues').nullable();
    table.text('status').notNullable().defaultTo('pending');
    table.integer('total_recipients').notNullable().defaultTo(0);
    table.integer('sent_count').notNullable().defaultTo(0);
    table.integer('failed_count').notNullable().defaultTo(0);
    table.text('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();

    table.index(['status']);
    table.index(['location_id']);
    table.index(['domain_id', 'created_at']);
  });

  await knex.schema.createTable('email_campaign_recipients', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('job_id').references('id').inTable('email_campaign_jobs').notNullable();
    table.text('to_email').notNullable();
    table.jsonb('context').notNullable();
    table.text('sendgrid_message_id').nullable();
    table.text('status').notNullable().defaultTo('pending');
    table.integer('attempt').notNullable().defaultTo(0);
    table.text('error').nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('delivered_at', { useTz: true }).nullable();
    table.timestamp('opened_at', { useTz: true }).nullable();
    table.timestamp('clicked_at', { useTz: true }).nullable();
    table.timestamp('bounced_at', { useTz: true }).nullable();

    table.index(['job_id', 'status']);
    table.index(['sendgrid_message_id']);
  });

  await knex.schema.createTable('email_recipient_clicks', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('recipient_id').references('id').inTable('email_campaign_recipients').notNullable();
    table.text('url').notNullable();
    table.timestamp('clicked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['recipient_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_recipient_clicks');
  await knex.schema.dropTableIfExists('email_campaign_recipients');
  await knex.schema.dropTableIfExists('email_campaign_jobs');
  await knex.schema.dropTableIfExists('email_sends');
  await knex.schema.dropTableIfExists('email_sending_domains');
}

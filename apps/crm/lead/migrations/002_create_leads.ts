import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').createTable('leads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('location_id').notNullable();
    table.varchar('first_name').notNullable();
    table.varchar('last_name').notNullable();
    table.varchar('phone').notNullable();
    table.varchar('email').nullable();
    table.varchar('treatment_interest').nullable();
    table.date('date_of_birth').nullable();
    table.varchar('channel').notNullable();
    table.varchar('contact_status').notNullable().defaultTo('active');
    table.varchar('current_pipeline').notNullable().defaultTo('none');
    table.varchar('current_stage').nullable();
    table.timestamp('last_activity_at', { useTz: true }).nullable();
    table.smallint('score').notNullable().defaultTo(0);
    table.varchar('duplicate_status').notNullable().defaultTo('none');
    table.uuid('duplicate_of_id').nullable();
    table.uuid('merged_into_id').nullable();
    table.timestamp('archived_at', { useTz: true }).nullable();
    table.varchar('first_touch_source').nullable();
    table.varchar('first_touch_medium').nullable();
    table.varchar('first_touch_campaign').nullable();
    table.varchar('first_touch_ad').nullable();
    table.varchar('first_touch_keyword').nullable();
    table.varchar('first_touch_landing_page').nullable();
    table.varchar('first_touch_referring_url').nullable();
    table.varchar('first_touch_device').nullable();
    table.varchar('call_tracking_number').nullable();
    table.uuid('referrer_id').nullable();
    table.varchar('referrer_type').nullable();
    table.varchar('referral_code').nullable();
    table.varchar('ad_platform_lead_id').nullable();
    table.uuid('created_by_location').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Check constraints
  await knex.raw(`
    ALTER TABLE crm_leads.leads
    ADD CONSTRAINT leads_channel_check
    CHECK (channel IN ('website_form','google_ads','facebook_ads','call_tracking','referral','walk_in','chat','google_business_profile','csv_import'))
  `);

  await knex.raw(`
    ALTER TABLE crm_leads.leads
    ADD CONSTRAINT leads_contact_status_check
    CHECK (contact_status IN ('active','sms_opted_out','email_invalid','fully_unreachable'))
  `);

  await knex.raw(`
    ALTER TABLE crm_leads.leads
    ADD CONSTRAINT leads_current_pipeline_check
    CHECK (current_pipeline IN ('new_patient','in_treatment','in_retention','none'))
  `);

  await knex.raw(`
    ALTER TABLE crm_leads.leads
    ADD CONSTRAINT leads_duplicate_status_check
    CHECK (duplicate_status IN ('none','flagged','resolved'))
  `);

  // B-tree indexes
  await knex.raw('CREATE INDEX leads_phone_idx ON crm_leads.leads (phone)');
  await knex.raw('CREATE INDEX leads_email_idx ON crm_leads.leads (email)');
  await knex.raw('CREATE INDEX leads_ad_platform_lead_id_idx ON crm_leads.leads (ad_platform_lead_id)');
  await knex.raw('CREATE INDEX leads_location_id_idx ON crm_leads.leads (location_id)');
  await knex.raw('CREATE INDEX leads_pipeline_stage_idx ON crm_leads.leads (current_pipeline, current_stage)');
  await knex.raw('CREATE INDEX leads_score_idx ON crm_leads.leads (score DESC)');
  await knex.raw('CREATE INDEX leads_last_activity_at_idx ON crm_leads.leads (last_activity_at DESC)');

  // GIN trigram indexes
  await knex.raw(`
    CREATE INDEX leads_name_trgm_idx ON crm_leads.leads
    USING gin ((first_name || ' ' || last_name) gin_trgm_ops)
  `);
  await knex.raw(`
    CREATE INDEX leads_phone_trgm_idx ON crm_leads.leads
    USING gin (phone gin_trgm_ops)
  `);
  await knex.raw(`
    CREATE INDEX leads_email_trgm_idx ON crm_leads.leads
    USING gin (email gin_trgm_ops)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').dropTableIfExists('leads');
}

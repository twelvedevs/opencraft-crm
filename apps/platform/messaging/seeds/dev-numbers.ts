import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  await knex('messaging_numbers')
    .insert([
      {
        location_id: '00000000-0000-0000-0000-000000000001',
        channel: 'google',
        phone_number: '+15550001001',
        friendly_name: 'Location 1 Google',
      },
      {
        location_id: '00000000-0000-0000-0000-000000000001',
        channel: 'sms_inbox',
        phone_number: '+15550001002',
        friendly_name: 'Location 1 SMS Inbox',
      },
      {
        location_id: '00000000-0000-0000-0000-000000000002',
        channel: 'google',
        phone_number: '+15550001003',
        friendly_name: 'Location 2 Google',
      },
      {
        location_id: '00000000-0000-0000-0000-000000000002',
        channel: 'sms_inbox',
        phone_number: '+15550001004',
        friendly_name: 'Location 2 SMS Inbox',
      },
    ])
    .onConflict('phone_number')
    .ignore();
}

import knexLib, { type Knex } from 'knex';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';

// Check if a real DB is available (not the fallback dummy URL)
const DATABASE_URL = process.env['DATABASE_URL'];
export const HAS_DB = !!DATABASE_URL && DATABASE_URL !== 'postgresql://localhost:5432/test_conversations';

// Test constants
export const LOCATION_ID = '00000000-0000-0000-0000-000000000001';
export const LEAD_ID = '00000000-0000-0000-0000-000000000010';
export const PRACTICE_NUMBER = '+15551234567';
export const LEAD_PHONE = '+15559876543';
export const USER_ID = '00000000-0000-0000-0000-000000000099';

let db: Knex | undefined;

export function getDb(): Knex {
  if (!db) {
    db = knexLib({
      client: 'pg',
      connection: DATABASE_URL!,
      searchPath: ['crm_conversations', 'public'],
    });
  }
  return db;
}

export function createMockEventBus() {
  const driver = new MockDriver();
  const bus = new EventBusImpl(driver);
  return { bus, driver };
}

export interface MockQueue {
  add: (...args: unknown[]) => Promise<{ id: string }>;
  jobs: Array<{ name: string; data: unknown; opts?: unknown }>;
}

export function createMockQueue(): MockQueue {
  const jobs: Array<{ name: string; data: unknown; opts?: unknown }> = [];
  const add = async (name: string, data: unknown, opts?: unknown) => {
    jobs.push({ name, data, opts });
    return { id: `mock-job-${jobs.length}` };
  };
  return { add, jobs };
}

export async function runMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.latest({
    directory: './migrations',
    schemaName: 'crm_conversations',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  });
}

export async function rollbackMigrations(): Promise<void> {
  const knex = getDb();
  await knex.migrate.rollback(
    {
      directory: './migrations',
      schemaName: 'crm_conversations',
      tableName: 'knex_migrations',
      loadExtensions: ['.ts'],
    },
    true,
  );
}

export async function cleanup(): Promise<void> {
  if (db) {
    await rollbackMigrations();
    await db.destroy();
    db = undefined;
  }
}

export async function truncateTables(): Promise<void> {
  const knex = getDb();
  await knex.raw(
    'TRUNCATE crm_conversations.bulk_send_jobs, crm_conversations.scheduled_messages, crm_conversations.conversation_reads, crm_conversations.conversation_notes, crm_conversations.conversation_messages, crm_conversations.conversations, crm_conversations.location_conversation_settings CASCADE',
  );
}

export const MOCK_LEAD = {
  id: LEAD_ID,
  location_id: LOCATION_ID,
  phone: LEAD_PHONE,
  current_stage: 'new_lead',
  treatment_interest: 'braces',
  name: 'Test Patient',
};

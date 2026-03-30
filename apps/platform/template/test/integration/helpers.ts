import { SignJWT } from 'jose';
import knex, { type Knex } from 'knex';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

export const TEST_JWT_SECRET = 'integration-test-secret-32-chars-ok!';

export const TEST_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

export async function makeStaffToken(sub = 'user-staff'): Promise<string> {
  const key = new TextEncoder().encode(TEST_JWT_SECRET);
  return new SignJWT({ sub, roles: ['marketing_staff'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key);
}

export async function makeManagerToken(sub = 'user-manager'): Promise<string> {
  const key = new TextEncoder().encode(TEST_JWT_SECRET);
  // Includes marketing_staff so the global requireRole('marketing_staff') preHandler passes
  return new SignJWT({ sub, roles: ['marketing_staff', 'marketing_manager'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key);
}

export function makeServiceApiKey(): string {
  return 'ak_test_service_key';
}

export async function resetSchema(db: Knex): Promise<void> {
  await db.raw('DROP SCHEMA IF EXISTS platform_templates CASCADE');
  const { up: up001 } = await import('../../migrations/001_create_templates.js');
  const { up: up002 } = await import('../../migrations/002_create_template_versions.js');
  await up001(db);
  await up002(db);
}

export async function truncateTables(db: Knex): Promise<void> {
  await db.raw('TRUNCATE platform_templates.template_versions CASCADE');
  await db.raw('TRUNCATE platform_templates.templates CASCADE');
}

export interface TestContext {
  app: FastifyInstance;
  db: Knex;
  serverUrl: string;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const db = knex({ client: 'pg', connection: TEST_DB_URL });
  const app = await buildApp(db, TEST_JWT_SECRET);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const serverUrl = `http://127.0.0.1:${addr.port}`;
  return {
    app,
    db,
    serverUrl,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

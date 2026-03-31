import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sign } from 'jsonwebtoken';
import knex from 'knex';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildApp } from '../helpers/build-app.js';
import type { FastifyInstance } from 'fastify';

const JWT_SECRET = 'test-secret';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_URL = process.env['DATABASE_URL'];

function mintJwt(role: string): string {
  return sign({ sub: 'test-user', role }, JWT_SECRET, { expiresIn: '1h' });
}

describe.skipIf(!DB_URL)('sequences API integration', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof knex>;
  const createdIds: string[] = [];
  const ts = Date.now();

  beforeAll(async () => {
    process.env['JWT_SECRET'] = JWT_SECRET;

    db = knex({
      client: 'pg',
      connection: DB_URL!,
      searchPath: ['platform_nurturing', 'public'],
    });

    const migrationKnex = knex({
      client: 'pg',
      connection: DB_URL!,
      searchPath: ['platform_nurturing', 'public'],
      migrations: {
        directory: join(__dirname, '../../migrations'),
        schemaName: 'platform_nurturing',
        tableName: 'knex_migrations',
        loadExtensions: ['.ts'],
      },
    });
    await migrationKnex.migrate.latest();
    await migrationKnex.destroy();

    app = await buildApp();
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await db('platform_nurturing.sequence_versions').whereIn('sequence_id', createdIds).delete();
      await db('platform_nurturing.sequence_definitions').whereIn('id', createdIds).delete();
    }
    await app.close();
    await db.destroy();
  });

  it('POST /sequences → 201 with expected shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: { name: `Test Sequence ${ts}` },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string; status: string; current_version: number; active_version: null }>();
    expect(body.id).toBeDefined();
    expect(body.status).toBe('draft');
    expect(body.current_version).toBe(1);
    expect(body.active_version).toBeNull();
    createdIds.push(body.id);
  });

  it('GET /sequences → 200, includes newly created sequence with step_count=0', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ id: string; step_count: number }>>();
    const found = body.find((s) => s.id === createdIds[0]);
    expect(found).toBeDefined();
    expect(found!.step_count).toBe(0);
  });

  it('GET /sequences/:id → 200, has current_version_data with steps=[] and active_version_data=null', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'GET',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ current_version_data: { steps: unknown[] }; active_version_data: null }>();
    expect(Array.isArray(body.current_version_data.steps)).toBe(true);
    expect(body.current_version_data.steps).toHaveLength(0);
    expect(body.active_version_data).toBeNull();
  });

  it('PUT /sequences/:id → 200, current_version bumped to 2, active_version remains null', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'PUT',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        steps: [{ id: 'step-1', delay: { value: 24, unit: 'hours' }, action: { type: 'send_message', params: {} } }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ definition: { current_version: number; active_version: null }; version: { version: number } }>();
    expect(body.definition.current_version).toBe(2);
    expect(body.definition.active_version).toBeNull();
    expect(body.version.version).toBe(2);
  });

  it('GET /sequences/:id after PUT → current_version_data.version=2 with 1 step, active_version_data=null', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'GET',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ current_version_data: { version: number; steps: unknown[] }; active_version_data: null }>();
    expect(body.current_version_data.version).toBe(2);
    expect(body.current_version_data.steps).toHaveLength(1);
    expect(body.active_version_data).toBeNull();
  });

  it('POST /sequences/:id/activate with marketing_manager JWT → 200, active_version=2, status=active', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'POST',
      url: `/sequences/${id}/activate`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ active_version: number; status: string }>();
    expect(body.active_version).toBe(2);
    expect(body.status).toBe('active');
  });

  it('POST /sequences/:id/activate with marketing_staff JWT → 403', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'POST',
      url: `/sequences/${id}/activate`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('POST /sequences/:id/activate with no Authorization header → 401', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'POST',
      url: `/sequences/${id}/activate`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('POST /sequences/:id/disable with marketing_manager JWT → 200, status=disabled', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'POST',
      url: `/sequences/${id}/disable`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string }>();
    expect(body.status).toBe('disabled');
  });

  it('POST /sequences/:id/disable with marketing_staff JWT → 403', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'POST',
      url: `/sequences/${id}/disable`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('GET /sequences/:id for non-existent UUID → 404 with { error: "sequence_not_found" }', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sequences/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'sequence_not_found' });
  });

  it('PUT /sequences/:id for non-existent UUID → 404 with { error: "sequence_not_found" }', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/sequences/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: { steps: [] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'sequence_not_found' });
  });
});

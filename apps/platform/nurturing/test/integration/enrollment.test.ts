import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import knex from 'knex';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { createApp } from '../../src/index.js';
import { createDb } from '../../src/db.js';
import type { StepJobData } from '../../src/queue/step-queue.js';
import { createMockQueue } from '../helpers/mock-queue.js';

const JWT_SECRET = 'test-secret';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_URL = process.env['DATABASE_URL'];

function mintJwt(role: string): string {
  return sign({ sub: 'test-user', role }, JWT_SECRET, { expiresIn: '1h' });
}

const twoSteps = [
  { id: 'step-1', delay: { value: 1, unit: 'days' }, action: { type: 'send_message', params: {} } },
  { id: 'step-2', delay: { value: 3, unit: 'days' }, action: { type: 'send_message', params: {} } },
];

describe.skipIf(!DB_URL)('enrollment integration', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDb>;
  const sequenceIds: string[] = [];
  const enrollmentIds: string[] = [];

  async function createAndActivateSequence(steps: unknown[]): Promise<string> {
    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `Enrollment Test Seq ${Date.now()}-${Math.random()}` },
    });
    const { id } = createRes.json<{ id: string }>();
    sequenceIds.push(id);

    await app.inject({
      method: 'PUT',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { steps },
    });

    await app.inject({
      method: 'POST',
      url: `/sequences/${id}/activate`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
    });

    return id;
  }

  beforeAll(async () => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    db = createDb();

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

    const mockQueue = createMockQueue();
    app = await createApp({ queue: mockQueue as unknown as Queue<StepJobData> });
    await app.ready();
  });

  afterAll(async () => {
    if (enrollmentIds.length > 0) {
      await db('platform_nurturing.sequence_step_executions')
        .whereIn('enrollment_id', enrollmentIds)
        .delete();
      await db('platform_nurturing.sequence_enrollments')
        .whereIn('id', enrollmentIds)
        .delete();
    }
    if (sequenceIds.length > 0) {
      await db('platform_nurturing.sequence_versions').whereIn('sequence_id', sequenceIds).delete();
      await db('platform_nurturing.sequence_definitions').whereIn('id', sequenceIds).delete();
    }
    await app.close();
    await db.destroy();
  });

  let mainEnrollmentId = '';
  let mainSequenceId = '';

  it('enroll → 201 with enrollment_id', async () => {
    mainSequenceId = await createAndActivateSequence(twoSteps);

    const res = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: mainSequenceId,
        entity_type: 'lead',
        entity_id: 'lead-001',
        context: {},
        dedup_key: `enroll-main-${Date.now()}-${Math.random()}`,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ enrollment_id: string }>();
    expect(body.enrollment_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    mainEnrollmentId = body.enrollment_id;
    enrollmentIds.push(mainEnrollmentId);
  });

  it('step executions pre-inserted with correct scheduled_at', async () => {
    const rows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: mainEnrollmentId })
      .orderBy('step_index')
      .select('*');

    expect(rows).toHaveLength(2);

    const expected24h = Date.now() + 24 * 3600 * 1000;
    const expected72h = Date.now() + 72 * 3600 * 1000;
    expect(Math.abs(new Date(rows[0].scheduled_at as string).getTime() - expected24h)).toBeLessThan(5000);
    expect(Math.abs(new Date(rows[1].scheduled_at as string).getTime() - expected72h)).toBeLessThan(5000);
  });

  it('job_id updated post-commit', async () => {
    const rows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: mainEnrollmentId })
      .select('job_id');

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.job_id).not.toBeNull();
      expect(typeof row.job_id).toBe('string');
    }
  });

  it('duplicate dedup_key → idempotent 200', async () => {
    const seqId = await createAndActivateSequence(twoSteps);
    const dedupKey = `dedup-${Date.now()}-${Math.random()}`;
    const payload = {
      sequence_id: seqId,
      entity_type: 'lead',
      entity_id: 'lead-002',
      context: {},
      dedup_key: dedupKey,
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload,
    });
    expect(res1.statusCode).toBe(201);
    const { enrollment_id } = res1.json<{ enrollment_id: string }>();
    enrollmentIds.push(enrollment_id);

    const res2 = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toMatchObject({ already_enrolled: true });

    const count = await db('platform_nurturing.sequence_enrollments')
      .where({ dedup_key: dedupKey })
      .count('id as c');
    expect(parseInt(String(count[0].c))).toBe(1);
  });

  it("disabled sequence → 422 with { error: 'sequence_disabled' }", async () => {
    const seqId = await createAndActivateSequence(twoSteps);
    await app.inject({
      method: 'POST',
      url: `/sequences/${seqId}/disable`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: seqId,
        entity_type: 'lead',
        entity_id: 'lead-003',
        context: {},
        dedup_key: `disabled-${Date.now()}-${Math.random()}`,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'sequence_disabled' });
  });

  it("draft sequence → 422 with { error: 'sequence_not_active' }", async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `Draft Seq ${Date.now()}-${Math.random()}` },
    });
    const { id: seqId } = createRes.json<{ id: string }>();
    sequenceIds.push(seqId);

    const res = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: seqId,
        entity_type: 'lead',
        entity_id: 'lead-004',
        context: {},
        dedup_key: `draft-${Date.now()}-${Math.random()}`,
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'sequence_not_active' });
  });

  it('non-existent sequence_id → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: randomUUID(),
        entity_type: 'lead',
        entity_id: 'lead-005',
        context: {},
        dedup_key: `notfound-${Date.now()}-${Math.random()}`,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'sequence_not_found' });
  });

  it('two concurrent enrollments with distinct dedup_key → both active', async () => {
    const seqId = await createAndActivateSequence(twoSteps);
    const entityId = `lead-concurrent-${Date.now()}`;

    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/sequences/enroll',
        headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
        payload: {
          sequence_id: seqId,
          entity_type: 'lead',
          entity_id: entityId,
          context: {},
          dedup_key: `concurrent-a-${Date.now()}-${Math.random()}`,
        },
      }),
      app.inject({
        method: 'POST',
        url: '/sequences/enroll',
        headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
        payload: {
          sequence_id: seqId,
          entity_type: 'lead',
          entity_id: entityId,
          context: {},
          dedup_key: `concurrent-b-${Date.now()}-${Math.random()}`,
        },
      }),
    ]);

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    const { enrollment_id: eid1 } = res1.json<{ enrollment_id: string }>();
    const { enrollment_id: eid2 } = res2.json<{ enrollment_id: string }>();
    enrollmentIds.push(eid1, eid2);

    const rows = await db('platform_nurturing.sequence_enrollments')
      .whereIn('id', [eid1, eid2])
      .select('status');

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('active');
    }
  });

  it('GET /sequences/:id/enrollments → lists enrollment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sequences/${mainSequenceId}/enrollments`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ entity_id: string; status: string }>>();
    const found = body.find((e) => e.entity_id === 'lead-001');
    expect(found).toBeDefined();
    expect(found!.status).toBe('active');
  });

  it('GET /sequences/:id/enrollments/:eid → detail with steps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sequences/${mainSequenceId}/enrollments/${mainEnrollmentId}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ steps: Array<{ step_id: string; step_index: number }> }>();
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].step_id).toBe('step-1');
    expect(body.steps[0].step_index).toBe(0);
    expect(body.steps[1].step_id).toBe('step-2');
    expect(body.steps[1].step_index).toBe(1);
  });
});

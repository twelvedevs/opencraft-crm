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

const threeSteps = [
  { id: 'step-1', delay: { value: 1, unit: 'days' }, action: { type: 'send_message', params: {} } },
  { id: 'step-2', delay: { value: 2, unit: 'days' }, action: { type: 'send_message', params: {} } },
  { id: 'step-3', delay: { value: 3, unit: 'days' }, action: { type: 'send_message', params: {} } },
];

describe.skipIf(!DB_URL)('unenroll integration', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDb>;
  const sequenceIds: string[] = [];
  const enrollmentIds: string[] = [];

  async function createAndActivateSequence(steps: unknown[]): Promise<string> {
    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `Unenroll Test Seq ${Date.now()}-${Math.random()}` },
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

  it('unenroll mid-sequence — pending steps cancelled, running step untouched', async () => {
    const sequenceId = await createAndActivateSequence(threeSteps);
    const entityId = `lead-unenroll-mid-${Date.now()}`;

    // Enroll the entity so we have a real active enrollment with step rows
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: entityId,
        context: {},
        dedup_key: `unenroll-main-${Date.now()}-${Math.random()}`,
      },
    });
    expect(enrollRes.statusCode).toBe(201);
    const { enrollment_id } = enrollRes.json<{ enrollment_id: string }>();
    enrollmentIds.push(enrollment_id);

    // Simulate an in-flight step by setting one step row to status='running'
    // (cancelPendingByEnrollment only cancels WHERE status='pending')
    await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id, step_index: 0 })
      .update({ status: 'running' });

    // Confirm we have 1 running + 2 pending
    const beforeRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id })
      .orderBy('step_index')
      .select('status');
    expect(beforeRows).toHaveLength(3);
    expect(beforeRows[0].status).toBe('running');
    expect(beforeRows[1].status).toBe('pending');
    expect(beforeRows[2].status).toBe('pending');

    const unenrollRes = await app.inject({
      method: 'POST',
      url: '/sequences/unenroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: entityId,
      },
    });
    expect(unenrollRes.statusCode).toBe(200);
    expect(unenrollRes.json()).toEqual({ ok: true });

    // Verify enrollment status
    const updatedEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollment_id })
      .first();
    expect(updatedEnrollment.status).toBe('unenrolled');

    // Verify step rows: running step untouched, pending steps cancelled
    const afterRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id })
      .orderBy('step_index')
      .select('status');
    expect(afterRows).toHaveLength(3);
    expect(afterRows[0].status).toBe('running');    // still running — untouched
    expect(afterRows[1].status).toBe('cancelled');  // was pending → cancelled
    expect(afterRows[2].status).toBe('cancelled');  // was pending → cancelled
  });

  it('unenroll — idempotent when no active enrollment', async () => {
    const sequenceId = await createAndActivateSequence(threeSteps);
    const nonExistentEntityId = `lead-nonexistent-${randomUUID()}`;

    const res = await app.inject({
      method: 'POST',
      url: '/sequences/unenroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: nonExistentEntityId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // No enrollments should exist for this entity
    const count = await db('platform_nurturing.sequence_enrollments')
      .where({ sequence_id: sequenceId, entity_id: nonExistentEntityId })
      .count('id as c');
    expect(parseInt(String(count[0].c))).toBe(0);
  });

  it('unenroll — idempotent when already unenrolled', async () => {
    const sequenceId = await createAndActivateSequence(threeSteps);
    const entityId = `lead-double-unenroll-${Date.now()}`;

    const enrollRes = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: entityId,
        context: {},
        dedup_key: `double-unenroll-${Date.now()}-${Math.random()}`,
      },
    });
    expect(enrollRes.statusCode).toBe(201);
    const { enrollment_id } = enrollRes.json<{ enrollment_id: string }>();
    enrollmentIds.push(enrollment_id);

    const payload = {
      sequence_id: sequenceId,
      entity_type: 'lead',
      entity_id: entityId,
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/sequences/unenroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload,
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toEqual({ ok: true });

    // Verify first unenroll worked
    const enrollmentAfterFirst = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollment_id })
      .first();
    expect(enrollmentAfterFirst.status).toBe('unenrolled');

    // Second unenroll — no active enrollment, so idempotent no-op
    const res2 = await app.inject({
      method: 'POST',
      url: '/sequences/unenroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ ok: true });

    // Status should remain 'unenrolled', no additional changes
    const enrollmentAfterSecond = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollment_id })
      .first();
    expect(enrollmentAfterSecond.status).toBe('unenrolled');
  });

  it('unenroll — returns 200 after enrollment was completed', async () => {
    const sequenceId = await createAndActivateSequence(threeSteps);
    const entityId = `lead-completed-${Date.now()}`;

    const enrollRes = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: entityId,
        context: {},
        dedup_key: `completed-unenroll-${Date.now()}-${Math.random()}`,
      },
    });
    expect(enrollRes.statusCode).toBe(201);
    const { enrollment_id } = enrollRes.json<{ enrollment_id: string }>();
    enrollmentIds.push(enrollment_id);

    // Manually mark the enrollment as completed (simulating end of sequence)
    await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollment_id })
      .update({ status: 'completed', completed_at: new Date() });

    // Unenroll — findActiveByEntity returns null (status='completed'), so idempotent 200
    const res = await app.inject({
      method: 'POST',
      url: '/sequences/unenroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: entityId,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // DB state unchanged — still 'completed'
    const enrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollment_id })
      .first();
    expect(enrollment.status).toBe('completed');
  });
});

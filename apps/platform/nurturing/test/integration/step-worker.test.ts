import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import knex from 'knex';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { Job, Queue } from 'bullmq';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { createApp } from '../../src/index.js';
import { createDb } from '../../src/db.js';
import type { StepJobData } from '../../src/queue/step-queue.js';
import { createMockQueue } from '../helpers/mock-queue.js';
import { EnrollmentsRepository } from '../../src/repositories/enrollments.repo.js';
import { SequenceVersionsRepository } from '../../src/repositories/sequence-versions.repo.js';
import { StepExecutionsRepository } from '../../src/repositories/step-executions.repo.js';
import { createStepProcessor, type StepWorkerDeps } from '../../src/services/step-worker.js';
import type { NurturingPublisher } from '../../src/events/publisher.js';

const JWT_SECRET = 'test-secret';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_URL = process.env['DATABASE_URL'];

function mintJwt(role: string): string {
  return sign({ sub: 'test-user', role }, JWT_SECRET, { expiresIn: '1h' });
}

function makeJob(data: StepJobData, attemptsMade = 0): Job<StepJobData> {
  return { data, attemptsMade, id: randomUUID() } as unknown as Job<StepJobData>;
}

describe.skipIf(!DB_URL)('step worker integration', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDb>;
  let appQueue: ReturnType<typeof createMockQueue>;
  let workerQueue: ReturnType<typeof createMockQueue>;
  let mockPublisher: Pick<
    NurturingPublisher,
    'publishStepOutputReady' | 'publishEnrollmentCompleted' | 'publishStepFailed'
  >;

  const sequenceIds: string[] = [];
  const enrollmentIds: string[] = [];

  async function createActiveSequence(
    steps: unknown[],
    activeHours?: unknown,
  ): Promise<string> {
    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `SW Test Seq ${Date.now()}-${Math.random()}` },
    });
    const { id } = createRes.json<{ id: string }>();
    sequenceIds.push(id);

    await app.inject({
      method: 'PUT',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { steps, ...(activeHours !== undefined ? { active_hours: activeHours } : {}) },
    });

    await app.inject({
      method: 'POST',
      url: `/sequences/${id}/activate`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
    });

    return id;
  }

  async function enrollEntity(
    sequenceId: string,
    context: Record<string, unknown>,
    dedupKey: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: `lead-${randomUUID()}`,
        context,
        dedup_key: dedupKey,
      },
    });
    const body = res.json<{ enrollment_id: string }>();
    enrollmentIds.push(body.enrollment_id);
    return body.enrollment_id;
  }

  function buildWorkerDeps(): StepWorkerDeps {
    return {
      db,
      enrollmentsRepo: new EnrollmentsRepository(db),
      versionsRepo: new SequenceVersionsRepository(db),
      stepExecutionsRepo: new StepExecutionsRepository(db),
      queue: workerQueue as unknown as Queue<StepJobData>,
      publisher: mockPublisher as unknown as NurturingPublisher,
      actionExecutorDeps: {
        urls: {
          templateServiceUrl: 'http://mock-template',
          messagingServiceUrl: 'http://mock-messaging',
          emailServiceUrl: 'http://mock-email',
          aiServiceUrl: 'http://mock-ai',
        },
        ebClient: {} as EventBridgeClient,
        busName: 'test-bus',
      },
    };
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

    appQueue = createMockQueue();
    app = await createApp({ queue: appQueue as unknown as Queue<StepJobData> });
    await app.ready();
  });

  beforeEach(() => {
    workerQueue = createMockQueue();
    mockPublisher = {
      publishStepOutputReady: vi.fn().mockResolvedValue(undefined),
      publishEnrollmentCompleted: vi.fn().mockResolvedValue(undefined),
      publishStepFailed: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      await db('platform_nurturing.sequence_versions')
        .whereIn('sequence_id', sequenceIds)
        .delete();
      await db('platform_nurturing.sequence_definitions')
        .whereIn('id', sequenceIds)
        .delete();
    }
    await app.close();
    await db.destroy();
  });

  it('step fires inside active hours window → send_message called with rendered body', async () => {
    const steps = [
      {
        id: 'step-1',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'send_message',
          params: {
            template_id: 'sms-template-test',
            to_field: '{{context.phone}}',
            from_field: '{{context.location_number}}',
            dedup_key: '{{enrollment_id}}-step-1',
          },
        },
      },
      {
        id: 'step-2',
        delay: { value: 1, unit: 'days' },
        action: { type: 'send_message', params: {} },
      },
    ];
    const activeHours = { start: '00:00', end: '23:59', timezone_field: 'context.timezone' };
    const seqId = await createActiveSequence(steps, activeHours);
    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550001111', location_number: '+15559999999', timezone: 'UTC' },
      `sw-happy-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId, step_id: 'step-1' })
      .select('*');
    expect(stepRows).toHaveLength(1);
    const stepRow = stepRows[0] as { id: string; step_id: string };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/templates/render')) {
        return new Response(JSON.stringify({ body: 'Hello test' }), { status: 200 });
      }
      if (urlStr.includes('/messages/send')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({ enrollment_id: enrollmentId, step_execution_id: stepRow.id, step_id: 'step-1' }),
    );

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const renderCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/templates/render'),
    );
    expect(renderCall).toBeDefined();

    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/messages/send'));
    expect(sendCall).toBeDefined();
    const sendBody = JSON.parse((sendCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(sendBody['body']).toBe('Hello test');
    expect(sendBody['to']).toBe('+15550001111');
    expect(sendBody['from']).toBe('+15559999999');

    const updatedStep = await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .first();
    expect(updatedStep.status).toBe('completed');

    const updatedEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentId })
      .first();
    expect(updatedEnrollment.status).toBe('active');
  });

  it('last step completes → enrollment marked completed and event published', async () => {
    const steps = [
      {
        id: 'step-1',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'send_message',
          params: {
            template_id: 'sms-template-test',
            to_field: '{{context.phone}}',
            from_field: '{{context.location_number}}',
            dedup_key: '{{enrollment_id}}-step-last',
          },
        },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550002222', location_number: '+15558888888', timezone: 'UTC' },
      `sw-last-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/templates/render')) {
        return new Response(JSON.stringify({ body: 'Last step!' }), { status: 200 });
      }
      if (urlStr.includes('/messages/send')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({ enrollment_id: enrollmentId, step_execution_id: stepRow.id, step_id: 'step-1' }),
    );

    const updatedEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentId })
      .first();
    expect(updatedEnrollment.status).toBe('completed');
    expect(updatedEnrollment.completed_at).not.toBeNull();

    expect(mockPublisher.publishEnrollmentCompleted).toHaveBeenCalledOnce();
    const publishCall = vi.mocked(mockPublisher.publishEnrollmentCompleted).mock.calls[0][0];
    expect(publishCall.enrollment_id).toBe(enrollmentId);
  });

  it('step fires outside active hours → deferred', async () => {
    vi.useFakeTimers();
    // Set to 22:00 UTC — outside 08:00–20:00 UTC window
    vi.setSystemTime(new Date('2026-03-31T22:00:00.000Z'));

    const steps = [
      {
        id: 'step-1',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'send_message',
          params: {
            template_id: 'sms-template-test',
            to_field: '{{context.phone}}',
            from_field: '{{context.location_number}}',
            dedup_key: '{{enrollment_id}}-step-defer',
          },
        },
      },
    ];
    const activeHours = { start: '08:00', end: '20:00', timezone_field: 'context.timezone' };
    const seqId = await createActiveSequence(steps, activeHours);
    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550003333', location_number: '+15557777777', timezone: 'UTC' },
      `sw-defer-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({ enrollment_id: enrollmentId, step_execution_id: stepRow.id, step_id: 'step-1' }),
    );

    // fetch must NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();

    // Step status reverted to 'pending' (via updateDeferral)
    const updatedStep = await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .first();
    expect(updatedStep.status).toBe('pending');

    // workerQueue.add was called with a positive delay
    const deferralJobs = workerQueue.getMockJobs();
    expect(deferralJobs.length).toBeGreaterThanOrEqual(1);
    const lastJob = deferralJobs[deferralJobs.length - 1];
    expect((lastJob.opts as { delay?: number })?.delay).toBeGreaterThan(0);

    // DB step job_id updated to new job id
    const refreshedStep = await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .first();
    expect(refreshedStep.job_id).not.toBeNull();
  });

  it('enrollment not active → step cancelled', async () => {
    const steps = [
      {
        id: 'step-1',
        delay: { value: 1, unit: 'minutes' },
        action: { type: 'send_message', params: {} },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550004444', timezone: 'UTC' },
      `sw-cancel-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    // Manually unenroll
    await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentId })
      .update({ status: 'unenrolled' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({ enrollment_id: enrollmentId, step_execution_id: stepRow.id, step_id: 'step-1' }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();

    const updatedStep = await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .first();
    expect(updatedStep.status).toBe('cancelled');
  });

  it('optimistic lock — duplicate job → only first proceeds', async () => {
    const steps = [
      {
        id: 'step-1',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'send_message',
          params: {
            template_id: 'sms-template-test',
            to_field: '{{context.phone}}',
            from_field: '{{context.location_number}}',
            dedup_key: '{{enrollment_id}}-step-lock',
          },
        },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550005555', location_number: '+15556666666', timezone: 'UTC' },
      `sw-lock-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    let fetchCallCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      fetchCallCount++;
      if (urlStr.includes('/templates/render')) {
        return new Response(JSON.stringify({ body: 'Lock test' }), { status: 200 });
      }
      if (urlStr.includes('/messages/send')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const jobData: StepJobData = {
      enrollment_id: enrollmentId,
      step_execution_id: stepRow.id,
      step_id: 'step-1',
    };

    // Two concurrent processor invocations with the same job data
    const deps1 = buildWorkerDeps();
    const deps2 = buildWorkerDeps();
    await Promise.all([
      createStepProcessor(deps1)(makeJob(jobData)),
      createStepProcessor(deps2)(makeJob(jobData)),
    ]);

    // fetch called exactly twice (template render + messages send) — only one processor proceeded
    expect(fetchCallCount).toBe(2);
  });
});

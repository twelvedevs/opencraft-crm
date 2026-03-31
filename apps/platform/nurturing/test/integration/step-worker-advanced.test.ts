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

describe.skipIf(!DB_URL)('step worker integration — advanced paths', () => {
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
    opts?: { activeHours?: unknown; abTest?: unknown },
  ): Promise<string> {
    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `SW Adv Test Seq ${Date.now()}-${Math.random()}` },
    });
    const { id } = createRes.json<{ id: string }>();
    sequenceIds.push(id);

    await app.inject({
      method: 'PUT',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: {
        steps,
        ...(opts?.activeHours !== undefined ? { active_hours: opts.activeHours } : {}),
        ...(opts?.abTest !== undefined ? { ab_test: opts.abTest } : {}),
      },
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

  function buildWorkerDeps(overrides?: { ebClient?: EventBridgeClient }): StepWorkerDeps {
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
        ebClient: overrides?.ebClient ?? ({} as EventBridgeClient),
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

  it('max retries exhausted → step failed, enrollment failed, event published', async () => {
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
            dedup_key: '{{enrollment_id}}-step-retry',
          },
        },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550009999', location_number: '+15551111111', timezone: 'UTC' },
      `sw-retry-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('service unavailable'));

    const jobData: StepJobData = {
      enrollment_id: enrollmentId,
      step_execution_id: stepRow.id,
      step_id: 'step-1',
    };

    const processor = createStepProcessor(buildWorkerDeps());

    // Attempts 0–3: error is re-thrown but step is NOT marked failed
    for (let attemptsMade = 0; attemptsMade <= 3; attemptsMade++) {
      // Reset step to 'pending' so optimistic lock succeeds each time
      await db('platform_nurturing.sequence_step_executions')
        .where({ id: stepRow.id })
        .update({ status: 'pending' });

      await expect(processor(makeJob(jobData, attemptsMade))).rejects.toThrow('service unavailable');

      const step = await db('platform_nurturing.sequence_step_executions')
        .where({ id: stepRow.id })
        .first();
      expect(step.status).not.toBe('failed');
    }

    // Attempt 4 (5th call, attemptsMade === 4): step and enrollment should be failed
    await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .update({ status: 'pending' });

    await expect(processor(makeJob(jobData, 4))).rejects.toThrow('service unavailable');

    const failedStep = await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .first();
    expect(failedStep.status).toBe('failed');

    const failedEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentId })
      .first();
    expect(failedEnrollment.status).toBe('failed');

    expect(mockPublisher.publishStepFailed).toHaveBeenCalledOnce();
    const failedCall = vi.mocked(mockPublisher.publishStepFailed).mock.calls[0][0];
    expect(failedCall.enrollment_id).toBe(enrollmentId);
    expect(failedCall.step_id).toBe('step-1');
    expect(failedCall.entity_type).toBe('lead');
    expect(failedCall.entity_id).toBeDefined();
    expect(failedCall.error).toBeTruthy();
  });

  it('call_ai with auto_send: false → output stored, step_output_ready published', async () => {
    const steps = [
      {
        id: 'step-ai-nosend',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'call_ai',
          params: {
            system_prompt: 'You are helpful',
            user_prompt: 'Draft message for {{context.first_name}}',
            model: 'claude-haiku-4-5-20251001',
            auto_send: false,
          },
        },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { first_name: 'Jane', phone: '+15550001234', timezone: 'UTC' },
      `sw-ai-nosend-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/ai/complete')) {
        return new Response(JSON.stringify({ text: 'Hello Jane, just checking in!' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({
        enrollment_id: enrollmentId,
        step_execution_id: stepRow.id,
        step_id: 'step-ai-nosend',
      }),
    );

    // AI output stored in DB
    const updatedStep = await db('platform_nurturing.sequence_step_executions')
      .where({ id: stepRow.id })
      .first();
    expect(updatedStep.status).toBe('completed');
    const storedOutput =
      typeof updatedStep.output === 'string'
        ? JSON.parse(updatedStep.output)
        : updatedStep.output;
    expect(storedOutput).toBe('Hello Jane, just checking in!');

    // step_output_ready published
    expect(mockPublisher.publishStepOutputReady).toHaveBeenCalledOnce();
    const readyCall = vi.mocked(mockPublisher.publishStepOutputReady).mock.calls[0][0];
    expect(readyCall.enrollment_id).toBe(enrollmentId);
    expect(readyCall.step_id).toBe('step-ai-nosend');

    // Messaging Service NOT called
    const fetchMock = vi.mocked(globalThis.fetch);
    const messagingCalled = fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/messages/send'),
    );
    expect(messagingCalled).toBe(false);
  });

  it('call_ai with auto_send: true → send_message called with AI body, no step_output_ready', async () => {
    const steps = [
      {
        id: 'step-ai-send',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'call_ai',
          params: {
            system_prompt: 'You are helpful',
            user_prompt: 'Draft message for {{context.first_name}}',
            model: 'claude-haiku-4-5-20251001',
            auto_send: true,
            to_field: 'context.phone',
            from_field: 'context.location_number',
            dedup_key: '{{enrollment_id}}-step-ai',
          },
        },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { first_name: 'Bob', phone: '+15550005678', location_number: '+15559990000', timezone: 'UTC' },
      `sw-ai-send-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/ai/complete')) {
        return new Response(JSON.stringify({ text: 'AI drafted text' }), { status: 200 });
      }
      if (urlStr.includes('/messages/send')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({
        enrollment_id: enrollmentId,
        step_execution_id: stepRow.id,
        step_id: 'step-ai-send',
      }),
    );

    const fetchMock = vi.mocked(globalThis.fetch);

    // Messaging Service was called with the AI-drafted body
    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/messages/send'),
    );
    expect(sendCall).toBeDefined();
    const sendBody = JSON.parse((sendCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(sendBody['body']).toBe('AI drafted text');

    // step_output_ready NOT published
    expect(mockPublisher.publishStepOutputReady).not.toHaveBeenCalled();
  });

  it('emit_event with include_context: true → context merged, explicit payload fields take precedence', async () => {
    const steps = [
      {
        id: 'step-emit',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'emit_event',
          params: {
            event_type: 'test.custom_event',
            payload: {
              entity_id: 'context.entity_id',
              stage: 'final',
            },
            include_context: true,
          },
        },
      },
    ];
    const seqId = await createActiveSequence(steps);
    const enrollmentId = await enrollEntity(
      seqId,
      { entity_id: 'lead-123', phone: '+15550001111', stage: 'overridden_by_explicit' },
      `sw-emit-${Date.now()}-${Math.random()}`,
    );

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    const mockEbSend = vi.fn().mockResolvedValue({});
    const mockEbClient = { send: mockEbSend } as unknown as EventBridgeClient;

    const processor = createStepProcessor(buildWorkerDeps({ ebClient: mockEbClient }));
    await processor(
      makeJob({
        enrollment_id: enrollmentId,
        step_execution_id: stepRow.id,
        step_id: 'step-emit',
      }),
    );

    expect(mockEbSend).toHaveBeenCalledOnce();
    const putEventsCommand = mockEbSend.mock.calls[0][0] as { input: { Entries: Array<{ Detail: string }> } };
    const detail = JSON.parse(putEventsCommand.input.Entries[0].Detail) as Record<string, unknown>;

    // All context fields included
    expect(detail['phone']).toBe('+15550001111');
    // entity_id resolved from context.entity_id
    expect(detail['entity_id']).toBe('lead-123');
    // Explicit payload 'stage: final' overrides context.stage
    expect(detail['stage']).toBe('final');
  });

  it('A/B variant override applied at execution', async () => {
    const steps = [
      {
        id: 'step-ab',
        delay: { value: 1, unit: 'minutes' },
        action: {
          type: 'send_message',
          params: {
            template_id: 'sms-template-a',
            to_field: '{{context.phone}}',
            from_field: '{{context.number}}',
            dedup_key: '{{enrollment_id}}-step-ab',
          },
        },
        ab_variant_override: {
          B: { template_id: 'sms-template-b' },
        },
      },
    ];

    const seqId = await createActiveSequence(steps, {
      abTest: { enabled: true, split: { A: 0, B: 100 } },
    });

    const enrollmentId = await enrollEntity(
      seqId,
      { phone: '+15550007777', number: '+15558882222', timezone: 'UTC' },
      `sw-ab-${Date.now()}-${Math.random()}`,
    );

    // Enrollment should have ab_variant = 'B' (100% B split)
    const enrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentId })
      .first();
    expect(enrollment.ab_variant).toBe('B');

    const stepRows = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentId })
      .select('*');
    const stepRow = stepRows[0] as { id: string };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/templates/render')) {
        return new Response(JSON.stringify({ body: 'Rendered text' }), { status: 200 });
      }
      if (urlStr.includes('/messages/send')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const processor = createStepProcessor(buildWorkerDeps());
    await processor(
      makeJob({
        enrollment_id: enrollmentId,
        step_execution_id: stepRow.id,
        step_id: 'step-ab',
      }),
    );

    // Template Service called with B's template_id override
    const fetchMock = vi.mocked(globalThis.fetch);
    const renderCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/templates/render'),
    );
    expect(renderCall).toBeDefined();
    const renderBody = JSON.parse((renderCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(renderBody['template_id']).toBe('sms-template-b');
  });
});

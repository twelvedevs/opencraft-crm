import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import knex from 'knex';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { createApp } from '../../src/index.js';
import { createDb } from '../../src/db.js';
import { StepExecutionsRepository } from '../../src/repositories/step-executions.repo.js';
import { runPollCycle } from '../../src/services/safety-net-poller.js';
import type { StepJobData } from '../../src/queue/step-queue.js';
import { createMockQueue } from '../helpers/mock-queue.js';

const JWT_SECRET = 'test-secret';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_URL = process.env['DATABASE_URL'];

function mintJwt(role: string): string {
  return sign({ sub: 'test-user', role }, JWT_SECRET, { expiresIn: '1h' });
}

function makeMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeMockRedis(setReturnValues: ('OK' | null)[] = ['OK']): Redis {
  const returns = [...setReturnValues];
  return {
    set: vi.fn().mockImplementation(() => Promise.resolve(returns.shift() ?? null)),
  } as unknown as Redis;
}

describe.skipIf(!DB_URL)('safety-net-poller integration', () => {
  let db: ReturnType<typeof createDb>;
  let stepExecutionsRepo: StepExecutionsRepository;
  const sequenceIds: string[] = [];
  const enrollmentIds: string[] = [];

  /** Create an active sequence via the HTTP API and return its id */
  async function createAndActivateSequence(): Promise<string> {
    const mockQueue = createMockQueue();
    const app = await createApp({ queue: mockQueue as unknown as Queue<StepJobData> });
    await app.ready();

    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `SafetyNet Test ${randomUUID()}` },
    });
    const { id } = createRes.json<{ id: string }>();
    sequenceIds.push(id);

    await app.inject({
      method: 'PUT',
      url: `/sequences/${id}`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: {
        steps: [{ id: 'step-1', delay: { value: 1, unit: 'hours' }, action: { type: 'send_message', params: {} } }],
      },
    });

    await app.inject({
      method: 'POST',
      url: `/sequences/${id}/activate`,
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
    });

    await app.close();
    return id;
  }

  /** Insert an enrollment row directly */
  async function insertEnrollment(sequenceId: string, entityId: string): Promise<string> {
    const id = randomUUID();
    await db('platform_nurturing.sequence_enrollments').insert({
      id,
      sequence_id: sequenceId,
      sequence_version: 1,
      entity_type: 'lead',
      entity_id: entityId,
      context: JSON.stringify({}),
      dedup_key: `test-dedup-${randomUUID()}`,
      status: 'active',
      ab_variant: null,
    });
    enrollmentIds.push(id);
    return id;
  }

  /** Insert a step_execution row with full control over job_id and scheduled_at */
  async function insertStepExecution(opts: {
    enrollmentId: string;
    jobId: string | null;
    scheduledAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const scheduledAt = opts.scheduledAt ?? new Date(Date.now() - 2 * 60 * 1000); // 2min past
    await db('platform_nurturing.sequence_step_executions').insert({
      id,
      enrollment_id: opts.enrollmentId,
      step_id: 'step-1',
      step_index: 0,
      scheduled_at: scheduledAt,
      job_id: opts.jobId,
      status: 'pending',
      attempt: 0,
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

    stepExecutionsRepo = new StepExecutionsRepository(db);
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
    await db.destroy();
  });

  it('safety-net-poller: re-enqueues orphaned step', async () => {
    const seqId = await createAndActivateSequence();
    const enrollmentId = await insertEnrollment(seqId, `poller-entity-${randomUUID()}`);
    // Simulate a BullMQ job that was enqueued but disappeared from Redis
    const stepExecId = await insertStepExecution({
      enrollmentId,
      jobId: 'lost-job-123',
      scheduledAt: new Date(Date.now() - 2 * 60 * 1000),
    });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    } as unknown as Queue<StepJobData>;
    const mockRedis = makeMockRedis(['OK']);
    const logger = makeMockLogger();

    await runPollCycle({ stepExecutionsRepo, stepQueue: mockStepQueue, redis: mockRedis, logger });

    expect(mockStepQueue.add).toHaveBeenCalledWith(
      'execute-step',
      expect.objectContaining({ enrollment_id: enrollmentId }),
      expect.objectContaining({ delay: 0, jobId: stepExecId }),
    );

    const updated = await stepExecutionsRepo.findById(stepExecId);
    expect(updated?.job_id).toBe('mock-job-id');
  });

  it('safety-net-poller: skips steps not yet overdue', async () => {
    const seqId = await createAndActivateSequence();
    const enrollmentId = await insertEnrollment(seqId, `poller-entity-${randomUUID()}`);
    // Step scheduled in the future (not overdue)
    await insertStepExecution({
      enrollmentId,
      jobId: 'active-job-id',
      scheduledAt: new Date(Date.now() + 30 * 1000),
    });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'should-not-be-called' }),
    } as unknown as Queue<StepJobData>;
    const mockRedis = makeMockRedis(['OK']);
    const logger = makeMockLogger();

    await runPollCycle({ stepExecutionsRepo, stepQueue: mockStepQueue, redis: mockRedis, logger });

    const callsForEnrollment = (mockStepQueue.add as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const data = args[1] as { enrollment_id: string };
        return data.enrollment_id === enrollmentId;
      },
    );
    expect(callsForEnrollment.length).toBe(0);
  });

  it('safety-net-poller: skips null-job-id steps', async () => {
    const seqId = await createAndActivateSequence();
    const enrollmentId = await insertEnrollment(seqId, `poller-entity-${randomUUID()}`);
    // job_id = NULL — startup scanner handles these, not the poller
    await insertStepExecution({
      enrollmentId,
      jobId: null,
      scheduledAt: new Date(Date.now() - 2 * 60 * 1000),
    });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'should-not-be-called' }),
    } as unknown as Queue<StepJobData>;
    const mockRedis = makeMockRedis(['OK']);
    const logger = makeMockLogger();

    await runPollCycle({ stepExecutionsRepo, stepQueue: mockStepQueue, redis: mockRedis, logger });

    const callsForEnrollment = (mockStepQueue.add as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const data = args[1] as { enrollment_id: string };
        return data.enrollment_id === enrollmentId;
      },
    );
    expect(callsForEnrollment.length).toBe(0);
  });

  it('safety-net-poller: Redis lock prevents concurrent cycle', async () => {
    const seqId = await createAndActivateSequence();
    const enrollmentId = await insertEnrollment(seqId, `poller-entity-${randomUUID()}`);
    await insertStepExecution({
      enrollmentId,
      jobId: 'orphaned-job',
      scheduledAt: new Date(Date.now() - 2 * 60 * 1000),
    });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'mock-job-concurrent' }),
    } as unknown as Queue<StepJobData>;
    // First call acquires lock ('OK'), second call sees lock held (null)
    const mockRedis = makeMockRedis(['OK', null]);
    const logger = makeMockLogger();

    const deps = { stepExecutionsRepo, stepQueue: mockStepQueue, redis: mockRedis, logger };
    await Promise.all([runPollCycle(deps), runPollCycle(deps)]);

    expect((mockRedis.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    const callsForEnrollment = (mockStepQueue.add as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const data = args[1] as { enrollment_id: string };
        return data.enrollment_id === enrollmentId;
      },
    );
    expect(callsForEnrollment.length).toBe(1);
  });

  it('safety-net-poller: dedup_key ensures no duplicate send — re-enqueued step uses same jobId as step.id', async () => {
    const seqId = await createAndActivateSequence();
    const enrollmentId = await insertEnrollment(seqId, `poller-entity-${randomUUID()}`);
    const stepExecId = await insertStepExecution({
      enrollmentId,
      jobId: 'original-disappeared-job',
      scheduledAt: new Date(Date.now() - 2 * 60 * 1000),
    });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'mock-dedup-job' }),
    } as unknown as Queue<StepJobData>;
    const mockRedis = makeMockRedis(['OK']);
    const logger = makeMockLogger();

    await runPollCycle({ stepExecutionsRepo, stepQueue: mockStepQueue, redis: mockRedis, logger });

    // jobId must equal step.id (UUID) — BullMQ deduplicates if original job reappears
    expect(mockStepQueue.add).toHaveBeenCalledWith(
      'execute-step',
      expect.anything(),
      expect.objectContaining({ jobId: stepExecId }),
    );
  });
});

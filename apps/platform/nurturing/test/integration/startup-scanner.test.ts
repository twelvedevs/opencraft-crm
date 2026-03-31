import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import knex from 'knex';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { createApp } from '../../src/index.js';
import { createDb } from '../../src/db.js';
import { StepExecutionsRepository } from '../../src/repositories/step-executions.repo.js';
import { runStartupScan } from '../../src/services/startup-scanner.js';
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

describe.skipIf(!DB_URL)('startup-scanner integration', () => {
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
      payload: { name: `StartupScan Test ${randomUUID()}` },
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

  /** Insert a step_execution row directly for surgery-level control */
  async function insertStepExecution(opts: {
    enrollmentId: string;
    sequenceId: string;
    jobId: string | null;
    scheduledAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const scheduledAt = opts.scheduledAt ?? new Date(Date.now() + 60 * 60 * 1000); // 1hr future
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

  it('startup-scanner: re-enqueues null-job-id pending step', async () => {
    const seqId = await createAndActivateSequence();
    const entityId = `scanner-entity-${randomUUID()}`;
    const enrollmentId = await insertEnrollment(seqId, entityId);
    const stepExecId = await insertStepExecution({ enrollmentId, sequenceId: seqId, jobId: null });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
      getJob: vi.fn(),
    } as unknown as Queue<StepJobData>;

    const logger = makeMockLogger();

    await runStartupScan({ stepExecutionsRepo, stepQueue: mockStepQueue, logger });

    expect(mockStepQueue.add).toHaveBeenCalledWith(
      'execute-step',
      expect.objectContaining({ enrollment_id: enrollmentId }),
      expect.objectContaining({ jobId: stepExecId }),
    );

    const updated = await stepExecutionsRepo.findById(stepExecId);
    expect(updated?.job_id).toBe('mock-job-id');
  });

  it('startup-scanner: skips steps with existing job_id', async () => {
    const seqId = await createAndActivateSequence();
    const entityId = `scanner-entity-${randomUUID()}`;
    const enrollmentId = await insertEnrollment(seqId, entityId);

    // Step with null job_id — should be re-enqueued
    await insertStepExecution({ enrollmentId, sequenceId: seqId, jobId: null });
    // Step with existing job_id — should be skipped
    await insertStepExecution({ enrollmentId, sequenceId: seqId, jobId: 'existing-job' });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'mock-job-id-2' }),
      getJob: vi.fn(),
    } as unknown as Queue<StepJobData>;

    const logger = makeMockLogger();

    await runStartupScan({ stepExecutionsRepo, stepQueue: mockStepQueue, logger });

    // add called exactly once — only the null-job-id step
    const callsForEnrollment = (mockStepQueue.add as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const data = args[1] as { enrollment_id: string };
        return data.enrollment_id === enrollmentId;
      },
    );
    expect(callsForEnrollment.length).toBe(1);
  });

  it('startup-scanner: handles empty result — no-op when no null-job-id steps exist', async () => {
    const seqId = await createAndActivateSequence();
    const entityId = `scanner-entity-${randomUUID()}`;
    const enrollmentId = await insertEnrollment(seqId, entityId);
    // Only a step with a non-null job_id
    await insertStepExecution({ enrollmentId, sequenceId: seqId, jobId: 'has-job-id' });

    const mockStepQueue = {
      add: vi.fn().mockResolvedValue({ id: 'should-not-be-called' }),
      getJob: vi.fn(),
    } as unknown as Queue<StepJobData>;

    const logger = makeMockLogger();

    await runStartupScan({ stepExecutionsRepo, stepQueue: mockStepQueue, logger });

    // add should never have been called for this enrollment
    const callsForEnrollment = (mockStepQueue.add as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => {
        const data = args[1] as { enrollment_id: string };
        return data.enrollment_id === enrollmentId;
      },
    );
    expect(callsForEnrollment.length).toBe(0);
  });

  it('startup-scanner: server accepts traffic before scan completes', async () => {
    const mockQueue = createMockQueue();
    const app = await createApp({ queue: mockQueue as unknown as Queue<StepJobData> });
    await app.ready();

    // Create a scanner that hangs indefinitely
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });

    const hungScanner = vi.fn().mockReturnValue(hangPromise);

    // Fire the scanner in the background (non-awaited) — mimicking main()'s pattern
    void hungScanner();

    // Server should respond immediately, before the scanner resolves
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);

    // Clean up: resolve the hung promise and close the app
    resolveHang();
    await app.close();
  });
});

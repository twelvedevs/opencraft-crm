import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import knex from 'knex';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createApp } from '../../src/index.js';
import { createDb } from '../../src/db.js';
import { EnrollmentsRepository } from '../../src/repositories/enrollments.repo.js';
import { StepExecutionsRepository } from '../../src/repositories/step-executions.repo.js';
import { processOptOutMessage } from '../../src/consumers/opt-out.consumer.js';
import { unenroll } from '../../src/services/unenrollment.js';
import type { UnenrollmentDeps } from '../../src/services/unenrollment.js';
import type { StepJobData } from '../../src/queue/step-queue.js';
import type { NurturingPublisher } from '../../src/events/publisher.js';
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
  { id: 'step-2', delay: { value: 2, unit: 'days' }, action: { type: 'send_message', params: {} } },
];

describe.skipIf(!DB_URL)('opt-out consumer integration', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDb>;
  let enrollmentsRepo: EnrollmentsRepository;
  let stepExecutionsRepo: StepExecutionsRepository;
  const sequenceIds: string[] = [];
  const enrollmentIds: string[] = [];

  async function createAndActivateSequence(steps: unknown[]): Promise<string> {
    const createRes = await app.inject({
      method: 'POST',
      url: '/sequences',
      headers: { authorization: `Bearer ${mintJwt('marketing_manager')}` },
      payload: { name: `OptOut Test Seq ${randomUUID()}` },
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

  async function enrollEntity(sequenceId: string, entityId: string, dedupKey: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/sequences/enroll',
      headers: { authorization: `Bearer ${mintJwt('marketing_staff')}` },
      payload: {
        sequence_id: sequenceId,
        entity_type: 'lead',
        entity_id: entityId,
        context: {},
        dedup_key: dedupKey,
      },
    });
    expect(res.statusCode).toBe(201);
    const { enrollment_id } = res.json<{ enrollment_id: string }>();
    enrollmentIds.push(enrollment_id);
    return enrollment_id;
  }

  function makeMockPublisher() {
    return {
      publishAllSequencesCancelled: vi.fn().mockResolvedValue(undefined),
      publishEnrollmentUnenrolled: vi.fn().mockResolvedValue(undefined),
      publishStepOutputReady: vi.fn().mockResolvedValue(undefined),
      publishEnrollmentCompleted: vi.fn().mockResolvedValue(undefined),
      publishStepFailed: vi.fn().mockResolvedValue(undefined),
    } as unknown as NurturingPublisher;
  }

  function makeMockLogger() {
    return {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
  }

  function makeUnenrollDeps(publisher: NurturingPublisher): UnenrollmentDeps {
    return {
      db,
      enrollmentsRepo,
      stepExecutionsRepo,
      stepQueue: {
        add: vi.fn().mockResolvedValue({ id: randomUUID() }),
        getJob: vi.fn().mockResolvedValue(null),
      } as unknown as Queue<StepJobData>,
      publisher,
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

    enrollmentsRepo = new EnrollmentsRepository(db);
    stepExecutionsRepo = new StepExecutionsRepository(db);

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

  it('opt_out.received — cancels all active enrollments for entity across sequences', async () => {
    const entity1Id = `opt-out-e1-${randomUUID()}`;
    const entity2Id = `opt-out-e2-${randomUUID()}`;

    const seqAId = await createAndActivateSequence(twoSteps);
    const seqBId = await createAndActivateSequence(twoSteps);

    const enrollmentE1SeqA = await enrollEntity(seqAId, entity1Id, `dedup-e1-seqa-${randomUUID()}`);
    const enrollmentE1SeqB = await enrollEntity(seqBId, entity1Id, `dedup-e1-seqb-${randomUUID()}`);
    const enrollmentE2SeqA = await enrollEntity(seqAId, entity2Id, `dedup-e2-seqa-${randomUUID()}`);

    const publisher = makeMockPublisher();
    const logger = makeMockLogger();
    const unenrollDeps = makeUnenrollDeps(publisher);

    const body = JSON.stringify({
      'detail-type': 'opt_out.received',
      source: 'platform.messaging',
      detail: { entity_id: entity1Id },
    });

    await processOptOutMessage(body, {
      sqsClient: {} as SQSClient,
      queueUrl: '',
      enrollmentsRepo,
      unenroll,
      unenrollDeps,
      publisher,
      logger,
    });

    // entity-1 seq-A: enrollment unenrolled, steps cancelled
    const e1SeqAEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentE1SeqA })
      .first();
    expect(e1SeqAEnrollment.status).toBe('unenrolled');

    const stepsE1SeqA = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentE1SeqA })
      .select('status');
    expect(stepsE1SeqA.length).toBeGreaterThan(0);
    expect(stepsE1SeqA.every((s: { status: string }) => s.status === 'cancelled')).toBe(true);

    // entity-1 seq-B: enrollment unenrolled, steps cancelled
    const e1SeqBEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentE1SeqB })
      .first();
    expect(e1SeqBEnrollment.status).toBe('unenrolled');

    const stepsE1SeqB = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentE1SeqB })
      .select('status');
    expect(stepsE1SeqB.length).toBeGreaterThan(0);
    expect(stepsE1SeqB.every((s: { status: string }) => s.status === 'cancelled')).toBe(true);

    // entity-2 in seq-A: untouched
    const e2SeqAEnrollment = await db('platform_nurturing.sequence_enrollments')
      .where({ id: enrollmentE2SeqA })
      .first();
    expect(e2SeqAEnrollment.status).toBe('active');

    const stepsE2SeqA = await db('platform_nurturing.sequence_step_executions')
      .where({ enrollment_id: enrollmentE2SeqA })
      .select('status');
    expect(stepsE2SeqA.length).toBeGreaterThan(0);
    expect(stepsE2SeqA.every((s: { status: string }) => s.status === 'pending')).toBe(true);

    // publishAllSequencesCancelled called with correct args
    expect(publisher.publishAllSequencesCancelled).toHaveBeenCalledOnce();
    expect(publisher.publishAllSequencesCancelled).toHaveBeenCalledWith({
      entity_type: 'lead',
      entity_id: entity1Id,
      cancelled_count: 2,
    });
  });

  it('opt_out.received — malformed event (missing detail.entity_id) does not throw', async () => {
    const publisher = makeMockPublisher();
    const logger = makeMockLogger();
    const unenrollDeps = makeUnenrollDeps(publisher);

    const body = JSON.stringify({ 'detail-type': 'opt_out.received' });

    await expect(
      processOptOutMessage(body, {
        sqsClient: {} as SQSClient,
        queueUrl: '',
        enrollmentsRepo,
        unenroll,
        unenrollDeps,
        publisher,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(publisher.publishAllSequencesCancelled).not.toHaveBeenCalled();
  });

  it('opt_out.received — malformed event (invalid JSON) does not throw', async () => {
    const publisher = makeMockPublisher();
    const logger = makeMockLogger();
    const unenrollDeps = makeUnenrollDeps(publisher);

    await expect(
      processOptOutMessage('not json', {
        sqsClient: {} as SQSClient,
        queueUrl: '',
        enrollmentsRepo,
        unenroll,
        unenrollDeps,
        publisher,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  it('opt_out.received — entity with no active enrollments', async () => {
    const entityId = `opt-out-no-enroll-${randomUUID()}`;
    const publisher = makeMockPublisher();
    const logger = makeMockLogger();
    const unenrollDeps = makeUnenrollDeps(publisher);

    const body = JSON.stringify({
      'detail-type': 'opt_out.received',
      source: 'platform.messaging',
      detail: { entity_id: entityId },
    });

    await expect(
      processOptOutMessage(body, {
        sqsClient: {} as SQSClient,
        queueUrl: '',
        enrollmentsRepo,
        unenroll,
        unenrollDeps,
        publisher,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(publisher.publishAllSequencesCancelled).toHaveBeenCalledOnce();
    expect(publisher.publishAllSequencesCancelled).toHaveBeenCalledWith({
      entity_type: 'unknown',
      entity_id: entityId,
      cancelled_count: 0,
    });
  });
});

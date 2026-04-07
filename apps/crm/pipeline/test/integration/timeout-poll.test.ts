import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import pg from 'pg';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  getDb,
  mockDriver,
  LOCATION_ID,
  LEAD_ID_1,
  LEAD_ID_2,
} from './helpers.js';
import { runPoll, resetIsRunning } from '../../src/jobs/timeout-poll.job.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';

const LEAD_PREFIX = '00000000-0000-0000-0000-0000000000';

describe.skipIf(!HAS_DB)('Timeout poll job (integration)', () => {
  let db: Knex;
  let testMockDriver: MockDriver;
  let testEventBus: InstanceType<typeof EventBusImpl>;

  beforeAll(async () => {
    await runMigrations();
    db = getDb();
    testMockDriver = new MockDriver();
    testEventBus = new EventBusImpl(testMockDriver);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    testMockDriver.published.length = 0;
    resetIsRunning();
  });

  /** Insert a membership directly into DB for poll testing */
  async function insertMembership(opts: {
    lead_id?: string;
    pipeline?: string;
    stage?: string;
    status?: string;
    timeout_at?: Date | null;
    entered_stage_at?: Date;
  }): Promise<string> {
    const now = new Date();
    const [row] = await db('pipeline_memberships')
      .insert({
        lead_id: opts.lead_id ?? LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: opts.pipeline ?? 'new_patient',
        stage: opts.stage ?? 'contacted',
        status: opts.status ?? 'active',
        entered_stage_at: opts.entered_stage_at ?? now,
        timeout_at: opts.timeout_at ?? null,
        previous_stage: null,
        last_transition_override: false,
        created_at: now,
        updated_at: now,
      })
      .returning('id');
    return row.id;
  }

  // ── Stage timeout transition ──────────────────────────────

  it('auto-transitions contacted → lost when timeout_at is past', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const id = await insertMembership({
      stage: 'contacted',
      timeout_at: twoDaysAgo,
      entered_stage_at: new Date(Date.now() - 7 * 86_400_000),
    });

    await runPoll(db, testEventBus);

    // Verify membership was transitioned to lost
    const m = await db('pipeline_memberships').where({ id }).first();
    expect(m.stage).toBe('lost');
    // lost has timeoutDays=30, so timeout_at should be ~30 days from now
    expect(m.timeout_at).not.toBeNull();
    const timeoutDiff = new Date(m.timeout_at).getTime() - Date.now();
    // Should be roughly 30 days in the future (allow 60s tolerance)
    expect(timeoutDiff).toBeGreaterThan(29 * 86_400_000);
    expect(timeoutDiff).toBeLessThan(31 * 86_400_000);

    // History row inserted
    const history = await db('pipeline_stage_history').where({ membership_id: id });
    expect(history).toHaveLength(1);
    expect(history[0].stage_from).toBe('contacted');
    expect(history[0].stage_to).toBe('lost');
    expect(history[0].reason).toBe('timeout');

    // Events: lead.stage_changed + lead.stage_timeout
    expect(testMockDriver.published).toHaveLength(2);

    const stageChanged = testMockDriver.published.find(
      (e) => e.event_type === 'lead.stage_changed',
    );
    expect(stageChanged).toBeDefined();
    const scPayload = stageChanged!.payload as Record<string, unknown>;
    expect(scPayload.stage_from).toBe('contacted');
    expect(scPayload.stage_to).toBe('lost');
    expect(scPayload.reason).toBe('timeout');

    const stageTimeout = testMockDriver.published.find(
      (e) => e.event_type === 'lead.stage_timeout',
    );
    expect(stageTimeout).toBeDefined();
    const stPayload = stageTimeout!.payload as Record<string, unknown>;
    expect(stPayload.timed_out_stage).toBe('contacted');
    expect(stPayload.new_stage).toBe('lost');
    expect(stPayload.exceeded_by_seconds).toBeGreaterThan(0);
  });

  // ── recall_due timeout ────────────────────────────────────

  it('auto-transitions recall_due → long_term_follow', async () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    const id = await insertMembership({
      pipeline: 'in_retention',
      stage: 'recall_due',
      timeout_at: oneHourAgo,
      entered_stage_at: new Date(Date.now() - 86_400_000),
    });

    await runPoll(db, testEventBus);

    const m = await db('pipeline_memberships').where({ id }).first();
    expect(m.stage).toBe('long_term_follow');

    // lead.stage_changed + lead.stage_timeout
    expect(testMockDriver.published).toHaveLength(2);
    expect(testMockDriver.published.some((e) => e.event_type === 'lead.stage_changed')).toBe(true);
    expect(testMockDriver.published.some((e) => e.event_type === 'lead.stage_timeout')).toBe(true);
  });

  // ── Lost archival ─────────────────────────────────────────

  it('archives lost membership when timeout_at is past', async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 86_400_000);
    const id = await insertMembership({
      stage: 'lost',
      timeout_at: thirtyOneDaysAgo,
      entered_stage_at: new Date(Date.now() - 61 * 86_400_000),
    });

    await runPoll(db, testEventBus);

    const m = await db('pipeline_memberships').where({ id }).first();
    expect(m.status).toBe('archived');
    expect(m.closed_reason).toBe('archived');
    expect(m.timeout_at).toBeNull();

    // NO history row inserted
    const history = await db('pipeline_stage_history').where({ membership_id: id });
    expect(history).toHaveLength(0);

    // Only lead.archived — NO stage_changed, NO stage_timeout
    expect(testMockDriver.published).toHaveLength(1);
    expect(testMockDriver.published[0].event_type).toBe('lead.archived');
    const payload = testMockDriver.published[0].payload as Record<string, unknown>;
    expect(payload.membership_id).toBe(id);
  });

  // ── Non-overdue row ───────────────────────────────────────

  it('does not process memberships with future timeout_at', async () => {
    const twoDaysFromNow = new Date(Date.now() + 2 * 86_400_000);
    const id = await insertMembership({
      stage: 'contacted',
      timeout_at: twoDaysFromNow,
    });

    await runPoll(db, testEventBus);

    const m = await db('pipeline_memberships').where({ id }).first();
    expect(m.stage).toBe('contacted');
    expect(m.status).toBe('active');
    expect(testMockDriver.published).toHaveLength(0);
  });

  // ── SKIP LOCKED ───────────────────────────────────────────

  it('skips rows locked by another transaction (SKIP LOCKED)', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const id = await insertMembership({
      stage: 'contacted',
      timeout_at: twoDaysAgo,
      entered_stage_at: new Date(Date.now() - 7 * 86_400_000),
    });

    // Hold a lock on the row using a raw pg Client
    const client = new pg.Client(process.env['DATABASE_URL']!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT * FROM crm_pipeline.pipeline_memberships WHERE id = $1 FOR UPDATE',
      [id],
    );

    try {
      // Run poll — should skip the locked row
      await runPoll(db, testEventBus);

      // Row should NOT have been processed
      const m = await db('pipeline_memberships').where({ id }).first();
      expect(m.stage).toBe('contacted');
      expect(m.status).toBe('active');
      expect(testMockDriver.published).toHaveLength(0);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  // ── Batch cap ─────────────────────────────────────────────

  it('processes at most 100 rows per poll run', async () => {
    const pastDate = new Date(Date.now() - 2 * 86_400_000);
    const enteredAt = new Date(Date.now() - 7 * 86_400_000);

    // Insert 101 overdue memberships (each needs unique lead_id for the partial unique index)
    const inserts = [];
    for (let i = 0; i < 101; i++) {
      const leadId = `${LEAD_PREFIX}${String(i).padStart(2, '0')}`;
      inserts.push({
        lead_id: leadId,
        location_id: LOCATION_ID,
        pipeline: 'new_patient',
        stage: 'contacted',
        status: 'active',
        entered_stage_at: enteredAt,
        timeout_at: pastDate,
        previous_stage: null,
        last_transition_override: false,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
    await db('pipeline_memberships').insert(inserts);

    await runPoll(db, testEventBus);

    // Count how many were transitioned to 'lost'
    const processed = await db('pipeline_memberships')
      .where({ stage: 'lost' })
      .count('id as count')
      .first();
    const remaining = await db('pipeline_memberships')
      .where({ stage: 'contacted' })
      .count('id as count')
      .first();

    expect(Number(processed!.count)).toBe(100);
    expect(Number(remaining!.count)).toBe(1);
  });
});

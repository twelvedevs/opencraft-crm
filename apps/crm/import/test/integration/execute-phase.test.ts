import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import type { Knex } from 'knex';
import {
  HAS_DB,
  getDb,
  runMigrations,
  cleanup,
  truncateTables,
  createMockS3Client,
  createSilentLogger,
  LOCATION_ID,
  USER_ID,
  LEAD_ID_1,
  LEAD_ID_2,
} from './helpers.js';
import { processImportJob } from '../../src/workers/import-job.js';
import { PipelineEngineClient } from '../../src/clients/pipeline-engine.js';
import { LeadServiceClient } from '../../src/clients/lead-service.js';
import type { ImportJobData } from '../../src/workers/import-job.js';

const PIPELINE_ENGINE_URL = 'http://localhost:4001';

const MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000100';
const POST_CONVERT_MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000200';

describe.skipIf(!HAS_DB)('execute phase (integration)', () => {
  let db: Knex;
  let pipelineClient: PipelineEngineClient;
  let leadClient: LeadServiceClient;
  const s3Client = createMockS3Client(''); // S3 not used in execute phase
  const log = createSilentLogger();

  beforeAll(async () => {
    if (!nock.isActive()) nock.activate();
    await runMigrations();
    db = getDb();
    pipelineClient = new PipelineEngineClient();
    leadClient = new LeadServiceClient();
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.restore();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  // ─── Helpers ─────────────────────────────────────────────────────

  async function seedImport(overrides: Record<string, unknown> = {}) {
    const importId = crypto.randomUUID();
    await db('crm_imports.imports').insert({
      id: importId,
      location_id: LOCATION_ID,
      import_type: 'active_patients',
      status: 'preview_ready',
      uploaded_by: USER_ID,
      file_name: 'test.csv',
      file_key: `imports/${importId}/raw.csv`,
      ...overrides,
    });
    return importId;
  }

  async function seedMatchedRow(
    importId: string,
    rowNumber: number,
    leadId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const rowId = crypto.randomUUID();
    await db('crm_imports.import_rows').insert({
      id: rowId,
      import_id: importId,
      row_number: rowNumber,
      raw_data: JSON.stringify({ PatFirst: 'Test', PatLast: 'User' }),
      matched_lead_id: leadId,
      match_tier: 1,
      status: 'matched',
      ...overrides,
    });
    return rowId;
  }

  function makeJobData(importId: string): ImportJobData {
    return { import_id: importId, phase: 'execute' };
  }

  // ─── active_patients happy path ──────────────────────────────────

  it('active_patients: before_snapshot written before Pipeline Engine calls, transitions + converts, row executed', async () => {
    const importId = await seedImport({ import_type: 'active_patients' });
    const rowId = await seedMatchedRow(importId, 1, LEAD_ID_1);

    let rowStateAtTransition: Record<string, unknown> | null = null;
    const callOrder: string[] = [];

    // 1. GET memberships -> active new_patient membership
    nock(PIPELINE_ENGINE_URL)
      .get('/pipeline/memberships')
      .query(true)
      .reply(200, [{ id: MEMBERSHIP_ID, stage: 'contacted' }]);

    // 2. POST transition -> capture DB state inside interceptor before responding
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(function (_uri, _body, cb) {
        callOrder.push('transition');
        db('crm_imports.import_rows')
          .where({ id: rowId })
          .first()
          .then((row: Record<string, unknown>) => {
            rowStateAtTransition = row;
            cb(null, [200, { id: MEMBERSHIP_ID }]);
          })
          .catch(() => {
            cb(null, [200, { id: MEMBERSHIP_ID }]);
          });
      });

    // 3. POST convert -> returns new membership id
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/convert`)
      .reply(200, function () {
        callOrder.push('convert');
        return { id: POST_CONVERT_MEMBERSHIP_ID };
      });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Verify: before_snapshot was in DB before transition HTTP call
    expect(rowStateAtTransition).not.toBeNull();
    expect(rowStateAtTransition!.status).toBe('executing');
    expect(rowStateAtTransition!.before_snapshot).not.toBeNull();

    const snapshot =
      typeof rowStateAtTransition!.before_snapshot === 'string'
        ? JSON.parse(rowStateAtTransition!.before_snapshot as string)
        : rowStateAtTransition!.before_snapshot;
    expect(snapshot.type).toBe('conversion');
    expect(snapshot.pre_import_pipeline).toBe('new_patient');
    expect(snapshot.pre_import_stage).toBe('contacted');

    // Verify call order: transition before convert
    expect(callOrder).toEqual(['transition', 'convert']);

    // Verify final row state
    const finalRow = await db('crm_imports.import_rows').where({ id: rowId }).first();
    expect(finalRow.status).toBe('executed');

    const finalSnapshot =
      typeof finalRow.before_snapshot === 'string'
        ? JSON.parse(finalRow.before_snapshot)
        : finalRow.before_snapshot;
    expect(finalSnapshot.post_import_membership_id).toBe(POST_CONVERT_MEMBERSHIP_ID);

    // Verify import state
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('completed');
    expect(importRecord.executed_count).toBe(1);
    expect(importRecord.failed_count).toBe(0);
    expect(importRecord.undo_deadline).not.toBeNull();
  });

  // ─── completed_patients happy path ───────────────────────────────

  it('completed_patients: transitions to treatment_complete, converts to in_retention, row executed', async () => {
    const importId = await seedImport({ import_type: 'completed_patients' });
    const rowId = await seedMatchedRow(importId, 1, LEAD_ID_1);

    // GET memberships for in_treatment pipeline -> active membership
    nock(PIPELINE_ENGINE_URL)
      .get('/pipeline/memberships')
      .query(true)
      .reply(200, [{ id: MEMBERSHIP_ID, stage: 'new_patient' }]);

    // POST transition to treatment_complete
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(200, { id: MEMBERSHIP_ID });

    // POST convert to in_retention/active_retention
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/convert`)
      .reply(200, { id: POST_CONVERT_MEMBERSHIP_ID });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Verify row state
    const finalRow = await db('crm_imports.import_rows').where({ id: rowId }).first();
    expect(finalRow.status).toBe('executed');

    const snapshot =
      typeof finalRow.before_snapshot === 'string'
        ? JSON.parse(finalRow.before_snapshot)
        : finalRow.before_snapshot;
    expect(snapshot.type).toBe('conversion');
    expect(snapshot.pre_import_pipeline).toBe('in_treatment');
    expect(snapshot.pre_import_stage).toBe('new_patient');
    expect(snapshot.post_import_membership_id).toBe(POST_CONVERT_MEMBERSHIP_ID);

    // Verify import state
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('completed');
    expect(importRecord.executed_count).toBe(1);
    expect(importRecord.failed_count).toBe(0);
  });

  // ─── Partial failure ─────────────────────────────────────────────

  it('partial failure: first row 404 from Pipeline Engine, second row succeeds', async () => {
    const importId = await seedImport({ import_type: 'active_patients' });
    const rowId1 = await seedMatchedRow(importId, 1, LEAD_ID_1);
    const rowId2 = await seedMatchedRow(importId, 2, LEAD_ID_2);

    // Row 1: GET memberships -> 404 (PipelineEngineError)
    nock(PIPELINE_ENGINE_URL)
      .get('/pipeline/memberships')
      .query(true)
      .reply(404, { error: 'not_found' });

    // Row 2: GET memberships -> active membership
    nock(PIPELINE_ENGINE_URL)
      .get('/pipeline/memberships')
      .query(true)
      .reply(200, [{ id: MEMBERSHIP_ID, stage: 'contacted' }]);

    // Row 2: POST transition
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(200, { id: MEMBERSHIP_ID });

    // Row 2: POST convert
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/convert`)
      .reply(200, { id: POST_CONVERT_MEMBERSHIP_ID });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Row 1: failed with pipeline_engine_error
    const row1 = await db('crm_imports.import_rows').where({ id: rowId1 }).first();
    expect(row1.status).toBe('failed');
    expect(row1.error_message).toContain('pipeline_engine_error');
    expect(row1.error_message).toContain('404');

    // Row 2: executed
    const row2 = await db('crm_imports.import_rows').where({ id: rowId2 }).first();
    expect(row2.status).toBe('executed');

    // Import completed with correct counts
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('completed');
    expect(importRecord.executed_count).toBe(1);
    expect(importRecord.failed_count).toBe(1);
  });

  // ─── Crash recovery ──────────────────────────────────────────────

  it('crash recovery: stuck "executing" row is skipped, matched rows processed normally', async () => {
    const importId = await seedImport({ import_type: 'active_patients' });

    // Seed a stuck row (simulating prior crash)
    const stuckRowId = await seedMatchedRow(importId, 1, LEAD_ID_1, {
      status: 'executing',
      before_snapshot: JSON.stringify({
        type: 'conversion',
        pre_import_membership_id: MEMBERSHIP_ID,
        pre_import_pipeline: 'new_patient',
        pre_import_stage: 'contacted',
        post_import_membership_id: null,
      }),
    });

    // Seed a normal matched row
    const matchedRowId = await seedMatchedRow(importId, 2, LEAD_ID_2);

    // Spy on warn log
    const warnSpy = vi.fn();
    const spyLogger = {
      info: () => {},
      warn: warnSpy,
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    } as unknown as import('pino').Logger;

    // Matched row processing: GET memberships, transition, convert
    nock(PIPELINE_ENGINE_URL)
      .get('/pipeline/memberships')
      .query(true)
      .reply(200, [{ id: MEMBERSHIP_ID, stage: 'contacted' }]);

    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(200, { id: MEMBERSHIP_ID });

    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/convert`)
      .reply(200, { id: POST_CONVERT_MEMBERSHIP_ID });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, spyLogger);

    // Stuck row remains in 'executing' state (not re-executed)
    const stuckRow = await db('crm_imports.import_rows').where({ id: stuckRowId }).first();
    expect(stuckRow.status).toBe('executing');

    // Matched row was processed normally
    const matchedRow = await db('crm_imports.import_rows').where({ id: matchedRowId }).first();
    expect(matchedRow.status).toBe('executed');

    // Warn log emitted for stuck row
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls[0];
    expect(warnCall[0]).toEqual(
      expect.objectContaining({ importId, rowId: stuckRowId }),
    );

    // Import completed — only the matched row counted
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('completed');
    expect(importRecord.executed_count).toBe(1);
  });
});

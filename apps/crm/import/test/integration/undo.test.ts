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
import { ImportService, ImportServiceError } from '../../src/services/import.service.js';
import { ImportRepository } from '../../src/repositories/import.repo.js';
import { ImportRowRepository } from '../../src/repositories/import-row.repo.js';
import { ColumnMappingRepository } from '../../src/repositories/column-mapping.repo.js';
import type { ImportJobData } from '../../src/workers/import-job.js';

const PIPELINE_ENGINE_URL = 'http://localhost:4001';
const LEAD_SERVICE_URL = 'http://localhost:4002';

const MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000100';
const POST_CONVERT_MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000200';
const APPOINTMENT_ID = '00000000-0000-0000-0000-000000000300';
const PRE_IMPORT_MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000400';

describe.skipIf(!HAS_DB)('undo phase (integration)', () => {
  let db: Knex;
  let pipelineClient: PipelineEngineClient;
  let leadClient: LeadServiceClient;
  const s3Client = createMockS3Client(''); // S3 not used in undo phase
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

  async function seedCompletedImport(overrides: Record<string, unknown> = {}) {
    const importId = crypto.randomUUID();
    await db('crm_imports.imports').insert({
      id: importId,
      location_id: LOCATION_ID,
      import_type: 'active_patients',
      status: 'completed',
      uploaded_by: USER_ID,
      file_name: 'test.csv',
      file_key: `imports/${importId}/raw.csv`,
      completed_at: new Date(),
      undo_deadline: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours from now
      ...overrides,
    });
    return importId;
  }

  async function seedExecutedRow(
    importId: string,
    rowNumber: number,
    leadId: string,
    beforeSnapshot: Record<string, unknown>,
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
      status: 'executed',
      before_snapshot: JSON.stringify(beforeSnapshot),
      ...overrides,
    });
    return rowId;
  }

  function makeJobData(importId: string): ImportJobData {
    return { import_id: importId, phase: 'undo' };
  }

  // ─── Transition undo (scheduled_appointments snapshot) ───────────

  it('transition undo: createTransition called with correct args, row undone, import undone', async () => {
    const importId = await seedCompletedImport({
      import_type: 'scheduled_appointments',
      status: 'undoing',
    });
    const rowId = await seedExecutedRow(importId, 1, LEAD_ID_1, {
      type: 'transition',
      membership_id: MEMBERSHIP_ID,
      stage: 'contacted',
      appointment_id: null,
    });

    let transitionBody: Record<string, unknown> | null = null;

    // Pipeline Engine: createTransition to revert stage
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`, (body: Record<string, unknown>) => {
        transitionBody = body;
        return true;
      })
      .reply(200, { id: MEMBERSHIP_ID });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Verify createTransition called with correct args
    expect(transitionBody).not.toBeNull();
    expect(transitionBody!.stage).toBe('contacted');
    expect(transitionBody!.override).toBe(true);
    expect(transitionBody!.reason).toBe('import_undo');
    expect(transitionBody!.triggered_by).toBe(USER_ID);

    // Verify row status = undone
    const row = await db('crm_imports.import_rows').where({ id: rowId }).first();
    expect(row.status).toBe('undone');

    // Verify import status = undone, undone_at set
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('undone');
    expect(importRecord.undone_at).not.toBeNull();
  });

  // ─── Transition undo with appointment_id ─────────────────────────

  it('transition undo with appointment_id: deleteAppointment called on Lead Service', async () => {
    const importId = await seedCompletedImport({
      import_type: 'scheduled_appointments',
      status: 'undoing',
    });
    await seedExecutedRow(importId, 1, LEAD_ID_1, {
      type: 'transition',
      membership_id: MEMBERSHIP_ID,
      stage: 'contacted',
      appointment_id: APPOINTMENT_ID,
    });

    // Pipeline Engine: createTransition
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(200, { id: MEMBERSHIP_ID });

    // Lead Service: deleteAppointment
    let deleteAppointmentCalled = false;
    nock(LEAD_SERVICE_URL)
      .delete(`/leads/${LEAD_ID_1}/appointments/${APPOINTMENT_ID}`)
      .reply(200, () => {
        deleteAppointmentCalled = true;
        return {};
      });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Verify deleteAppointment was called
    expect(deleteAppointmentCalled).toBe(true);

    // Verify row undone
    const rows = await db('crm_imports.import_rows').where({ import_id: importId });
    expect(rows[0].status).toBe('undone');
  });

  // ─── Conversion undo (active_patients snapshot) ──────────────────

  it('conversion undo: closeMembership then enrollMembership with correct args, location_id from import', async () => {
    const importId = await seedCompletedImport({
      import_type: 'active_patients',
      status: 'undoing',
    });
    await seedExecutedRow(importId, 1, LEAD_ID_1, {
      type: 'conversion',
      pre_import_membership_id: PRE_IMPORT_MEMBERSHIP_ID,
      pre_import_pipeline: 'new_patient',
      pre_import_stage: 'contacted',
      post_import_membership_id: POST_CONVERT_MEMBERSHIP_ID,
    });

    const callOrder: string[] = [];
    let closeBody: Record<string, unknown> | null = null;
    let enrollBody: Record<string, unknown> | null = null;

    // Pipeline Engine: closeMembership (first)
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${POST_CONVERT_MEMBERSHIP_ID}/close`, (body: Record<string, unknown>) => {
        closeBody = body;
        callOrder.push('close');
        return true;
      })
      .reply(200, { id: POST_CONVERT_MEMBERSHIP_ID });

    // Pipeline Engine: enrollMembership (second)
    nock(PIPELINE_ENGINE_URL)
      .post('/pipeline/memberships', (body: Record<string, unknown>) => {
        enrollBody = body;
        callOrder.push('enroll');
        return true;
      })
      .reply(200, { id: crypto.randomUUID() });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Verify call order: close before enroll
    expect(callOrder).toEqual(['close', 'enroll']);

    // Verify closeMembership args
    expect(closeBody).not.toBeNull();
    expect(closeBody!.triggered_by).toBe(USER_ID);
    expect(closeBody!.reason).toBe('import_undo');

    // Verify enrollMembership args
    expect(enrollBody).not.toBeNull();
    expect(enrollBody!.lead_id).toBe(PRE_IMPORT_MEMBERSHIP_ID);
    expect(enrollBody!.pipeline).toBe('new_patient');
    expect(enrollBody!.stage).toBe('contacted');
    expect(enrollBody!.triggered_by).toBe(USER_ID);
    expect(enrollBody!.reason).toBe('import_undo');
    // location_id comes from importRecord, not snapshot
    expect(enrollBody!.location_id).toBe(LOCATION_ID);

    // Verify row undone
    const rows = await db('crm_imports.import_rows').where({ import_id: importId });
    expect(rows[0].status).toBe('undone');

    // Verify import undone
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('undone');
  });

  // ─── Partial undo failure ────────────────────────────────────────

  it('partial undo failure: failed row stays executed, other rows complete, import still undone', async () => {
    const importId = await seedCompletedImport({
      import_type: 'active_patients',
      status: 'undoing',
    });

    // Row 1 (row_number=2, processed first due to DESC order): will fail
    const failRowId = await seedExecutedRow(importId, 2, LEAD_ID_1, {
      type: 'conversion',
      pre_import_membership_id: PRE_IMPORT_MEMBERSHIP_ID,
      pre_import_pipeline: 'new_patient',
      pre_import_stage: 'contacted',
      post_import_membership_id: POST_CONVERT_MEMBERSHIP_ID,
    });

    // Row 2 (row_number=1, processed second due to DESC order): will succeed
    const successRowId = await seedExecutedRow(importId, 1, LEAD_ID_2, {
      type: 'transition',
      membership_id: MEMBERSHIP_ID,
      stage: 'exam_scheduled',
      appointment_id: null,
    });

    // Row 1 (row_number=2, DESC → first): closeMembership returns 500
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${POST_CONVERT_MEMBERSHIP_ID}/close`)
      .reply(500, { error: 'internal_error' });

    // Row 2 (row_number=1, DESC → second): createTransition succeeds
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(200, { id: MEMBERSHIP_ID });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Failed row stays 'executed' with error_message set
    const failRow = await db('crm_imports.import_rows').where({ id: failRowId }).first();
    expect(failRow.status).toBe('executed');
    expect(failRow.error_message).not.toBeNull();

    // Successful row is 'undone'
    const successRow = await db('crm_imports.import_rows').where({ id: successRowId }).first();
    expect(successRow.status).toBe('undone');

    // Import status is still 'undone' (best-effort)
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('undone');
  });

  // ─── Rows with status='executing' skipped ────────────────────────

  it('rows with status executing are skipped by undo, warn log emitted', async () => {
    const importId = await seedCompletedImport({
      import_type: 'active_patients',
      status: 'undoing',
    });

    // Seed a stuck row with status 'executing' (simulating prior crash)
    const stuckRowId = await seedExecutedRow(importId, 2, LEAD_ID_1, {
      type: 'conversion',
      pre_import_membership_id: PRE_IMPORT_MEMBERSHIP_ID,
      pre_import_pipeline: 'new_patient',
      pre_import_stage: 'contacted',
      post_import_membership_id: POST_CONVERT_MEMBERSHIP_ID,
    }, { status: 'executing' });

    // Seed a normal executed row
    const executedRowId = await seedExecutedRow(importId, 1, LEAD_ID_2, {
      type: 'transition',
      membership_id: MEMBERSHIP_ID,
      stage: 'exam_scheduled',
      appointment_id: null,
    });

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

    // Executed row undo: createTransition
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(200, { id: MEMBERSHIP_ID });

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, spyLogger);

    // Stuck row remains in 'executing' (not processed by undo)
    const stuckRow = await db('crm_imports.import_rows').where({ id: stuckRowId }).first();
    expect(stuckRow.status).toBe('executing');

    // Executed row was undone
    const executedRow = await db('crm_imports.import_rows').where({ id: executedRowId }).first();
    expect(executedRow.status).toBe('undone');

    // Warn log emitted for stuck row
    expect(warnSpy).toHaveBeenCalled();
    const warnCall = warnSpy.mock.calls[0];
    expect(warnCall[0]).toEqual(
      expect.objectContaining({ importId, rowId: stuckRowId }),
    );

    // Import still marked undone
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('undone');
  });

  // ─── Undo past deadline (route-level) ────────────────────────────

  it('undo past deadline: initiateUndo throws 422 with undo_window_expired', async () => {
    const importId = await seedCompletedImport({
      undo_deadline: new Date(Date.now() - 60_000), // 1 minute ago
    });

    const importRepo = new ImportRepository(db);
    const importRowRepo = new ImportRowRepository(db);
    const columnMappingRepo = new ColumnMappingRepository(db);
    const importService = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

    try {
      await importService.initiateUndo(importId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportServiceError);
      const serviceErr = err as ImportServiceError;
      expect(serviceErr.statusCode).toBe(422);
      expect(serviceErr.body).toEqual({ error: 'undo_window_expired' });
    }
  });

  // ─── Undo when status = 'undoing' (route-level) ──────────────────

  it('undo when status is undoing: initiateUndo throws 409', async () => {
    const importId = await seedCompletedImport({
      status: 'undoing',
    });

    const importRepo = new ImportRepository(db);
    const importRowRepo = new ImportRowRepository(db);
    const columnMappingRepo = new ColumnMappingRepository(db);
    const importService = new ImportService(importRepo, importRowRepo, columnMappingRepo, db);

    try {
      await importService.initiateUndo(importId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportServiceError);
      const serviceErr = err as ImportServiceError;
      expect(serviceErr.statusCode).toBe(409);
    }
  });
});

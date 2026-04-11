import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
} from './helpers.js';
import { processImportJob } from '../../src/workers/import-job.js';
import { PipelineEngineClient } from '../../src/clients/pipeline-engine.js';
import { LeadServiceClient } from '../../src/clients/lead-service.js';
import type { ImportJobData } from '../../src/workers/import-job.js';

const PIPELINE_ENGINE_URL = 'http://localhost:4001';
const MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000100';
const POST_CONVERT_MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000200';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!HAS_DB)('contract tests (integration)', () => {
  let db: Knex;
  let pipelineClient: PipelineEngineClient;
  let leadClient: LeadServiceClient;
  const s3Client = createMockS3Client('');
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

  // ─── active_patients contract ────────────────────────────────────

  it('active_patients: every request has override:true, triggered_by is non-null UUID, /convert has channel:import, snapshot written before first response', async () => {
    const importId = await seedImport({ import_type: 'active_patients' });
    const rowId = await seedMatchedRow(importId, 1, LEAD_ID_1);

    const capturedBodies: { endpoint: string; body: Record<string, unknown> }[] = [];
    let rowStateAtFirstPipelineResponse: Record<string, unknown> | null = null;

    // GET memberships → active new_patient membership
    nock(PIPELINE_ENGINE_URL)
      .get('/pipeline/memberships')
      .query(true)
      .reply(200, [{ id: MEMBERSHIP_ID, stage: 'contacted' }]);

    // POST transition → capture body AND read DB state inside interceptor
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/transition`)
      .reply(function (_uri, body, cb) {
        capturedBodies.push({ endpoint: 'transition', body: body as Record<string, unknown> });

        // Read DB state at the moment Pipeline Engine first responds
        db('crm_imports.import_rows')
          .where({ id: rowId })
          .first()
          .then((row: Record<string, unknown>) => {
            rowStateAtFirstPipelineResponse = row;
            cb(null, [200, { id: MEMBERSHIP_ID }]);
          })
          .catch(() => cb(null, [200, { id: MEMBERSHIP_ID }]));
      });

    // POST convert → capture body
    nock(PIPELINE_ENGINE_URL)
      .post(`/pipeline/memberships/${MEMBERSHIP_ID}/convert`)
      .reply(function (_uri, body) {
        capturedBodies.push({ endpoint: 'convert', body: body as Record<string, unknown> });
        return [200, { id: POST_CONVERT_MEMBERSHIP_ID }];
      });

    const jobData: ImportJobData = { import_id: importId, phase: 'execute' };
    await processImportJob(jobData, db, s3Client, pipelineClient, leadClient, log);

    // ─── Contract: every request body has override: true ───────────
    expect(capturedBodies.length).toBeGreaterThanOrEqual(2);
    for (const { body } of capturedBodies) {
      expect(body.override).toBe(true);
    }

    // ─── Contract: triggered_by is a non-null UUID string ─────────
    for (const { body } of capturedBodies) {
      expect(body.triggered_by).toBeTruthy();
      expect(String(body.triggered_by)).toMatch(UUID_REGEX);
    }

    // ─── Contract: /convert body has channel: 'import' ────────────
    const convertCapture = capturedBodies.find((c) => c.endpoint === 'convert');
    expect(convertCapture).toBeDefined();
    expect(convertCapture!.body.channel).toBe('import');

    // ─── Contract: before_snapshot IS NOT NULL and status = 'executing'
    //     at the moment the first Pipeline Engine mock responds ─────
    expect(rowStateAtFirstPipelineResponse).not.toBeNull();
    expect(rowStateAtFirstPipelineResponse!.status).toBe('executing');
    expect(rowStateAtFirstPipelineResponse!.before_snapshot).not.toBeNull();
  });
});

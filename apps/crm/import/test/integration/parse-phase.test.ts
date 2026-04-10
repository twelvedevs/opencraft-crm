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
  createFailingS3Client,
  createMockPipelineClient,
  createSilentLogger,
  LOCATION_ID,
  USER_ID,
  LEAD_ID_1,
  LEAD_ID_2,
  LEAD_ID_3,
  LEAD_SERVICE_URL,
} from './helpers.js';
import { processImportJob } from '../../src/workers/import-job.js';
import { LeadServiceClient } from '../../src/clients/lead-service.js';
import type { ImportJobData } from '../../src/workers/import-job.js';

describe.skipIf(!HAS_DB)('parse_match phase (integration)', () => {
  let db: Knex;
  let leadClient: LeadServiceClient;
  const log = createSilentLogger();
  const pipelineClient = createMockPipelineClient();

  beforeAll(async () => {
    await runMigrations();
    db = getDb();
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

  /**
   * Seed an import record in the DB and return its id.
   */
  async function seedImport(overrides: Record<string, unknown> = {}) {
    const importId = crypto.randomUUID();
    await db('crm_imports.imports').insert({
      id: importId,
      location_id: LOCATION_ID,
      import_type: 'active_patients',
      status: 'uploading',
      uploaded_by: USER_ID,
      file_name: 'test.csv',
      file_key: `imports/${importId}/raw.csv`,
      ...overrides,
    });
    return importId;
  }

  function makeJobData(importId: string): ImportJobData {
    return { import_id: importId, phase: 'parse_match' };
  }

  // ─── Happy path: 3-row CSV with tier 1, tier 2, and unmatched ─────

  it('parses 3-row CSV: phone match (tier 1), email match (tier 2), unmatched (tier 5)', async () => {
    const importId = await seedImport();

    const csv = [
      'PatFirst,PatLast,CellPhone,Email,HomePhone,Birthdate',
      'John,Doe,(212) 123-4567,,,',
      'Jane,Smith,,test@example.com,,',
      'Unknown,Person,,,,',
    ].join('\n');

    const s3Client = createMockS3Client(csv);

    // Nock interceptors in call order:
    // 1. Batch phone search
    nock(LEAD_SERVICE_URL)
      .get('/leads')
      .query(true)
      .reply(200, [{ id: LEAD_ID_1, mobile_phone: '+12121234567' }]);

    // 2. Batch email search
    nock(LEAD_SERVICE_URL)
      .get('/leads')
      .query(true)
      .reply(200, [{ id: LEAD_ID_2, email: 'test@example.com' }]);

    // 3. Tier 3 name search for "Unknown Person" — no results
    nock(LEAD_SERVICE_URL)
      .get('/leads')
      .query(true)
      .reply(200, []);

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    // Verify import record
    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('preview_ready');
    expect(importRecord.row_count).toBe(3);
    expect(importRecord.matched_count).toBe(2);
    expect(importRecord.unmatched_count).toBe(1);
    expect(importRecord.ambiguous_count).toBe(0);

    // Verify detected_headers
    expect(importRecord.detected_headers).toEqual([
      'PatFirst', 'PatLast', 'CellPhone', 'Email', 'HomePhone', 'Birthdate',
    ]);

    // Verify import rows
    const rows = await db('crm_imports.import_rows')
      .where({ import_id: importId })
      .orderBy('row_number', 'asc');

    expect(rows).toHaveLength(3);

    // Row 1: phone match tier 1
    expect(rows[0].status).toBe('matched');
    expect(rows[0].match_tier).toBe(1);
    expect(rows[0].matched_lead_id).toBe(LEAD_ID_1);

    // Row 2: email match tier 2
    expect(rows[1].status).toBe('matched');
    expect(rows[1].match_tier).toBe(2);
    expect(rows[1].matched_lead_id).toBe(LEAD_ID_2);

    // Row 3: unmatched
    expect(rows[2].status).toBe('unmatched');
    expect(rows[2].match_tier).toBeNull();
    expect(rows[2].matched_lead_id).toBeNull();
  });

  // ─── All-unmatched CSV ────────────────────────────────────────────

  it('all-unmatched CSV sets matched_count=0 and unmatched_count=N', async () => {
    const importId = await seedImport();

    const csv = [
      'PatFirst,PatLast,CellPhone,Email',
      'Alice,Wonderland,,',
      'Bob,Builder,,',
    ].join('\n');

    const s3Client = createMockS3Client(csv);

    // No phones/emails → no batch searches.
    // Two name search calls for tier 3 (both return empty).
    nock(LEAD_SERVICE_URL)
      .get('/leads')
      .query(true)
      .reply(200, [])
      .get('/leads')
      .query(true)
      .reply(200, []);

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('preview_ready');
    expect(importRecord.matched_count).toBe(0);
    expect(importRecord.unmatched_count).toBe(2);

    const rows = await db('crm_imports.import_rows')
      .where({ import_id: importId })
      .orderBy('row_number', 'asc');
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('unmatched');
    expect(rows[1].status).toBe('unmatched');
  });

  // ─── S3 read failure ──────────────────────────────────────────────

  it('S3 read failure sets import status to failed with error_message', async () => {
    const importId = await seedImport();
    const s3Client = createFailingS3Client('AccessDenied: bucket not found');

    // processImportJob catches and sets status=failed, then re-throws
    await expect(
      processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log),
    ).rejects.toThrow('AccessDenied: bucket not found');

    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('failed');
    expect(importRecord.error_message).toBe('AccessDenied: bucket not found');

    // No import_rows should have been created
    const rows = await db('crm_imports.import_rows').where({ import_id: importId });
    expect(rows).toHaveLength(0);
  });

  // ─── Saved column_mapping overrides auto-detected headers ─────────

  it('saved column_mapping overrides auto-detected header mapping', async () => {
    const importId = await seedImport();

    // Seed a saved column_mapping for 'active_patients' that maps email to 'MyEmail'
    // instead of the auto-detected 'Email' column
    await db('crm_imports.column_mappings').insert({
      import_type: 'active_patients',
      mapping: JSON.stringify({ email: 'MyEmail' }),
      updated_by: USER_ID,
      updated_at: new Date(),
    });

    // CSV has both 'Email' and 'MyEmail' columns.
    // Auto-detect would map email→'Email' (via ORTHO2 headers: Email→email).
    // Saved mapping overrides: email→'MyEmail'.
    const csv = [
      'PatFirst,PatLast,CellPhone,Email,MyEmail',
      'Jane,Doe,,wrong@test.com,correct@test.com',
    ].join('\n');

    const s3Client = createMockS3Client(csv);

    // No phones → no phone batch search.
    // Email batch search for 'correct@test.com' (from MyEmail column, not Email)
    nock(LEAD_SERVICE_URL)
      .get('/leads')
      .query((qs) => qs['emails[]'] === 'correct@test.com')
      .reply(200, [{ id: LEAD_ID_3, email: 'correct@test.com' }]);

    await processImportJob(makeJobData(importId), db, s3Client, pipelineClient, leadClient, log);

    const importRecord = await db('crm_imports.imports').where({ id: importId }).first();
    expect(importRecord.status).toBe('preview_ready');
    expect(importRecord.matched_count).toBe(1);

    const rows = await db('crm_imports.import_rows').where({ import_id: importId });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('matched');
    expect(rows[0].match_tier).toBe(2);
    expect(rows[0].matched_lead_id).toBe(LEAD_ID_3);
  });
});

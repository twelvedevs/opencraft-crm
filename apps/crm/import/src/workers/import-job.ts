import { Worker, type Queue } from 'bullmq';
import type { Knex } from 'knex';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { env } from '../env.js';
import { ImportRepository } from '../repositories/import.repo.js';
import { ImportRowRepository } from '../repositories/import-row.repo.js';
import { ColumnMappingRepository } from '../repositories/column-mapping.repo.js';
import { MatchService, normalizePhone, buildPhoneMap, buildEmailMap, type Lead } from '../services/match.service.js';
import { autoDetectMapping } from '../mapping/ortho2-headers.js';
import { PipelineEngineError, type PipelineEngineClient } from '../clients/pipeline-engine.js';
import { LeadServiceError, type LeadServiceClient } from '../clients/lead-service.js';
import type { Import, ImportRow } from '../types.js';

export interface ImportJobData {
  import_id: string;
  phase: 'parse_match' | 'execute' | 'undo';
}

async function parseMatchPhase(
  job: { data: ImportJobData },
  knex: Knex,
  s3Client: S3Client,
  leadClient: LeadServiceClient,
  log: Logger,
): Promise<void> {
  const importId = job.data.import_id;
  const importRepo = new ImportRepository(knex);
  const importRowRepo = new ImportRowRepository(knex);
  const columnMappingRepo = new ColumnMappingRepository(knex);
  const matchService = new MatchService(undefined as unknown as PipelineEngineClient, leadClient);

  // (1) Update status to parsing
  await importRepo.update(importId, { status: 'parsing' });

  // (2) Fetch CSV from S3
  const importRecord = await importRepo.findById(importId);
  if (!importRecord) throw new Error(`Import ${importId} not found`);

  const s3Response = await s3Client.send(
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `imports/${importId}/raw.csv`,
    }),
  );

  const bodyStream = s3Response.Body as Readable;

  // (3) Parse CSV
  const records: Record<string, string>[] = [];
  const parser = bodyStream.pipe(
    parse({ columns: true, skip_empty_lines: true }),
  );

  for await (const record of parser) {
    records.push(record as Record<string, string>);
  }

  // (4) Extract detected headers from first record's keys
  const detectedHeaders =
    records.length > 0 ? Object.keys(records[0]) : [];

  // (5) Load saved column_mapping + merge with auto-detected
  const savedMapping = await columnMappingRepo.findByType(
    importRecord.import_type,
  );
  const autoMapping = autoDetectMapping(detectedHeaders);
  // Saved mapping overrides auto-detected keys
  const columnMapping: Record<string, string> = {
    ...autoMapping,
    ...(savedMapping?.mapping ?? {}),
  };

  // Build reverse mapping: CRM field → CSV header value extractor
  // columnMapping is CRM field → CSV header name
  // We need to map each record's CSV header → CRM field for matchRow
  function mapRow(raw: Record<string, string>): Record<string, string> {
    const mapped: Record<string, string> = {};
    for (const [crmField, csvHeader] of Object.entries(columnMapping)) {
      if (raw[csvHeader] !== undefined) {
        mapped[crmField] = raw[csvHeader];
      }
    }
    return mapped;
  }

  // (6) Collected all parsed rows above

  // (7) Batch prefetch — extract all phones and emails
  const allPhones: string[] = [];
  const allEmails: string[] = [];

  for (const raw of records) {
    const mapped = mapRow(raw);
    if (mapped.mobile_phone) {
      const normalized = normalizePhone(mapped.mobile_phone);
      if (normalized) allPhones.push(normalized);
    }
    if (mapped.email) {
      allEmails.push(mapped.email);
    }
  }

  let phoneMap = new Map<string, Lead[]>();
  let emailMap = new Map<string, Lead[]>();

  if (allPhones.length > 0) {
    const phoneLeads = (await leadClient.searchLeads({
      phones: allPhones,
      location_id: importRecord.location_id,
    })) as Lead[];
    phoneMap = buildPhoneMap(phoneLeads);
  }

  if (allEmails.length > 0) {
    const emailLeads = (await leadClient.searchLeads({
      emails: allEmails,
      location_id: importRecord.location_id,
    })) as Lead[];
    emailMap = buildEmailMap(emailLeads);
  }

  // (8) Match each row
  let matchedCount = 0;
  let unmatchedCount = 0;
  let ambiguousCount = 0;

  const rowInserts: Array<Record<string, unknown>> = [];

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    const mapped = mapRow(raw);
    const result = await matchService.matchRow(
      mapped,
      phoneMap,
      emailMap,
      leadClient,
      importRecord.location_id,
    );

    if (result.status === 'matched') matchedCount++;
    else if (result.status === 'unmatched') unmatchedCount++;
    else if (result.status === 'ambiguous') ambiguousCount++;

    rowInserts.push({
      id: crypto.randomUUID(),
      import_id: importId,
      row_number: i + 1,
      raw_data: JSON.stringify(raw),
      matched_lead_id: result.matchedLeadId ?? null,
      match_tier: result.matchTier ?? null,
      candidate_ids: result.candidateIds ?? null,
      status: result.status,
    });
  }

  // (9) Batch insert all rows
  await importRowRepo.batchInsert(rowInserts);

  // (10) Update import with counts and status
  await importRepo.update(importId, {
    row_count: records.length,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    ambiguous_count: ambiguousCount,
    detected_headers: detectedHeaders,
    status: 'preview_ready',
  });

  log.info(
    { importId, rowCount: records.length, matchedCount, unmatchedCount, ambiguousCount },
    'parse_match phase complete',
  );
}

async function executeActivePatients(
  row: ImportRow,
  importRecord: Import,
  pipelineClient: PipelineEngineClient,
  importRowRepo: ImportRowRepository,
): Promise<boolean> {
  const leadId = row.matched_lead_id!;
  const triggeredBy = importRecord.uploaded_by;

  const memberships = (await pipelineClient.getMemberships(leadId, 'new_patient', 'active')) as Array<{ id: string; stage: string }>;
  if (memberships.length === 0) {
    await importRowRepo.update(row.id, { status: 'failed', error_message: 'no_active_membership' });
    return false;
  }

  const membership = memberships[0];

  // Write before_snapshot atomically before any external calls
  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify({
      type: 'conversion',
      pre_import_membership_id: membership.id,
      pre_import_pipeline: 'new_patient',
      pre_import_stage: membership.stage,
      post_import_membership_id: null,
    }) as unknown as Record<string, unknown>,
    status: 'executing',
  });

  // Transition to contract_signed if not already there
  if (membership.stage !== 'contract_signed') {
    await pipelineClient.createTransition(membership.id, {
      stage: 'contract_signed',
      override: true,
      triggered_by: triggeredBy,
      reason: 'import',
    });
  }

  // Convert to in_treatment
  const convertResponse = (await pipelineClient.convertMembership(membership.id, {
    to_pipeline: 'in_treatment',
    to_stage: 'new_patient',
    triggered_by: triggeredBy,
    reason: 'converted',
    channel: 'import',
  })) as { id: string };

  // Update snapshot with post_import_membership_id and mark executed
  const currentRow = await importRowRepo.update(row.id, { status: 'executed' });
  const snapshot = currentRow.before_snapshot as Record<string, unknown>;
  snapshot.post_import_membership_id = convertResponse.id;
  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify(snapshot) as unknown as Record<string, unknown>,
  });
  return true;
}

async function executeCompletedPatients(
  row: ImportRow,
  importRecord: Import,
  pipelineClient: PipelineEngineClient,
  importRowRepo: ImportRowRepository,
): Promise<boolean> {
  const leadId = row.matched_lead_id!;
  const triggeredBy = importRecord.uploaded_by;

  const memberships = (await pipelineClient.getMemberships(leadId, 'in_treatment', 'active')) as Array<{ id: string; stage: string }>;
  if (memberships.length === 0) {
    await importRowRepo.update(row.id, { status: 'failed', error_message: 'no_active_membership' });
    return false;
  }

  const membership = memberships[0];

  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify({
      type: 'conversion',
      pre_import_membership_id: membership.id,
      pre_import_pipeline: 'in_treatment',
      pre_import_stage: membership.stage,
      post_import_membership_id: null,
    }) as unknown as Record<string, unknown>,
    status: 'executing',
  });

  if (membership.stage !== 'treatment_complete') {
    await pipelineClient.createTransition(membership.id, {
      stage: 'treatment_complete',
      override: true,
      triggered_by: triggeredBy,
      reason: 'import',
    });
  }

  const convertResponse = (await pipelineClient.convertMembership(membership.id, {
    to_pipeline: 'in_retention',
    to_stage: 'active_retention',
    triggered_by: triggeredBy,
    reason: 'converted',
    channel: 'import',
  })) as { id: string };

  const currentRow2 = await importRowRepo.update(row.id, { status: 'executed' });
  const snapshot2 = currentRow2.before_snapshot as Record<string, unknown>;
  snapshot2.post_import_membership_id = convertResponse.id;
  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify(snapshot2) as unknown as Record<string, unknown>,
  });
  return true;
}

async function executeScheduledAppointments(
  row: ImportRow,
  importRecord: Import,
  pipelineClient: PipelineEngineClient,
  leadClient: LeadServiceClient,
  importRowRepo: ImportRowRepository,
  columnMapping: Record<string, string>,
): Promise<boolean> {
  const leadId = row.matched_lead_id!;
  const triggeredBy = importRecord.uploaded_by;

  const memberships = (await pipelineClient.getMemberships(leadId, 'new_patient', 'active')) as Array<{ id: string; stage: string }>;
  if (memberships.length === 0) {
    await importRowRepo.update(row.id, { status: 'failed', error_message: 'no_active_membership' });
    return false;
  }

  const membership = memberships[0];

  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify({
      type: 'transition',
      membership_id: membership.id,
      stage: membership.stage,
      appointment_id: null,
    }) as unknown as Record<string, unknown>,
    status: 'executing',
  });

  // Skip transition if already at exam_scheduled
  if (membership.stage !== 'exam_scheduled') {
    await pipelineClient.createTransition(membership.id, {
      stage: 'exam_scheduled',
      override: true,
      triggered_by: triggeredBy,
      reason: 'import',
    });
  }

  // Create appointment on Lead Service
  const rawData = row.raw_data as Record<string, string>;
  const apptDateHeader = columnMapping.appointment_date;
  const apptTimeHeader = columnMapping.appointment_time;
  const apptDate = apptDateHeader ? rawData[apptDateHeader] : undefined;
  const apptTime = apptTimeHeader ? rawData[apptTimeHeader] : undefined;

  const scheduledAt = apptDate && apptTime
    ? `${apptDate} ${apptTime}`
    : apptDate ?? new Date().toISOString();

  const appointmentResponse = (await leadClient.createAppointment(leadId, {
    appointment_type: 'exam',
    scheduled_at: scheduledAt,
    status: 'scheduled',
    created_by: triggeredBy,
  })) as { id: string };

  // Update snapshot with appointment_id and mark executed
  const currentRow3 = await importRowRepo.update(row.id, { status: 'executed' });
  const snapshot3 = currentRow3.before_snapshot as Record<string, unknown>;
  snapshot3.appointment_id = appointmentResponse.id;
  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify(snapshot3) as unknown as Record<string, unknown>,
  });
  return true;
}

async function executeNoShows(
  row: ImportRow,
  importRecord: Import,
  pipelineClient: PipelineEngineClient,
  importRowRepo: ImportRowRepository,
): Promise<boolean> {
  const leadId = row.matched_lead_id!;
  const triggeredBy = importRecord.uploaded_by;

  const memberships = (await pipelineClient.getMemberships(leadId, 'new_patient', 'active')) as Array<{ id: string; stage: string }>;
  if (memberships.length === 0) {
    await importRowRepo.update(row.id, { status: 'failed', error_message: 'no_active_membership' });
    return false;
  }

  const membership = memberships[0];

  if (membership.stage !== 'exam_scheduled') {
    await importRowRepo.update(row.id, { status: 'failed', error_message: 'unexpected_stage' });
    return false;
  }

  await importRowRepo.update(row.id, {
    before_snapshot: JSON.stringify({
      type: 'transition',
      membership_id: membership.id,
      stage: membership.stage,
    }) as unknown as Record<string, unknown>,
    status: 'executing',
  });

  await pipelineClient.createTransition(membership.id, {
    stage: 'contacted',
    override: true,
    triggered_by: triggeredBy,
    reason: 'no_show',
  });

  await importRowRepo.update(row.id, { status: 'executed' });
  return true;
}

async function executePhase(
  job: { data: ImportJobData },
  knex: Knex,
  pipelineClient: PipelineEngineClient,
  leadClient: LeadServiceClient,
  log: Logger,
): Promise<void> {
  const importId = job.data.import_id;
  const importRepo = new ImportRepository(knex);
  const importRowRepo = new ImportRowRepository(knex);

  // Update status to executing
  await importRepo.update(importId, { status: 'executing' });

  const importRecord = await importRepo.findById(importId);
  if (!importRecord) throw new Error(`Import ${importId} not found`);

  // Get column mapping for scheduled_appointments handler
  const columnMapping = importRecord.column_mapping ?? {};

  // Crash recovery: check for rows stuck in 'executing' from a prior crashed run
  const stuckRows = await importRowRepo.findByImportIdAndStatus(importId, ['executing']);
  for (const stuckRow of stuckRows) {
    log.warn({ importId, rowId: stuckRow.id, rowNumber: stuckRow.row_number }, 'skipping row stuck in executing state from prior run');
  }

  // Query matched rows
  const matchedRows = await importRowRepo.findMatchedByImportId(importId);

  let executedCount = 0;
  let failedCount = 0;

  // Sequential processing
  for (const row of matchedRows) {
    try {
      let success = false;
      switch (importRecord.import_type) {
        case 'active_patients':
          success = await executeActivePatients(row, importRecord, pipelineClient, importRowRepo);
          break;
        case 'completed_patients':
          success = await executeCompletedPatients(row, importRecord, pipelineClient, importRowRepo);
          break;
        case 'scheduled_appointments':
          success = await executeScheduledAppointments(row, importRecord, pipelineClient, leadClient, importRowRepo, columnMapping);
          break;
        case 'no_shows':
          success = await executeNoShows(row, importRecord, pipelineClient, importRowRepo);
          break;
        default:
          throw new Error(`Unknown import type: ${importRecord.import_type}`);
      }

      if (success) {
        executedCount++;
      } else {
        failedCount++;
      }
    } catch (err) {
      if (err instanceof PipelineEngineError || err instanceof LeadServiceError) {
        const errorMessage = err instanceof PipelineEngineError
          ? `pipeline_engine_error: ${err.httpStatus}`
          : `lead_service_error: ${(err as LeadServiceError).httpStatus}`;
        await importRowRepo.update(row.id, { status: 'failed', error_message: errorMessage });
        failedCount++;
      } else {
        throw err;
      }
    }
  }

  // Update import with final counts
  await importRepo.update(importId, {
    executed_count: executedCount,
    failed_count: failedCount,
    status: 'completed',
    completed_at: new Date(),
    undo_deadline: knex.raw("now() + interval '2 hours'") as unknown as Date,
  });

  log.info({ importId, executedCount, failedCount }, 'execute phase complete');
}

export function startWorker(
  queue: Queue,
  knex: Knex,
  s3Client: S3Client,
  pipelineClient: PipelineEngineClient,
  leadClient: LeadServiceClient,
  log: Logger,
): Worker<ImportJobData> {
  const worker = new Worker<ImportJobData>(
    'import-jobs',
    async (job) => {
      const { import_id, phase } = job.data;
      log.info({ importId: import_id, phase }, 'processing import job');

      const importRepo = new ImportRepository(knex);

      try {
        switch (phase) {
          case 'parse_match':
            await parseMatchPhase(job, knex, s3Client, leadClient, log);
            break;
          case 'execute':
            await executePhase(job, knex, pipelineClient, leadClient, log);
            break;
          case 'undo':
            // Added in US-010
            break;
          default:
            throw new Error(`Unknown phase: ${phase}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ importId: import_id, phase, err: message }, 'import job failed');
        await importRepo.update(import_id, {
          status: 'failed',
          error_message: message,
        });
        throw err;
      }
    },
    {
      connection: { url: env.REDIS_URL },
      concurrency: 2,
    },
  );

  return worker;
}

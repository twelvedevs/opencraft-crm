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
import type { PipelineEngineClient } from '../clients/pipeline-engine.js';
import type { LeadServiceClient } from '../clients/lead-service.js';

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
            // Added in US-009
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

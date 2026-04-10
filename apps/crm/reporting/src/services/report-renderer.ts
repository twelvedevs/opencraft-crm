import { createLogger } from '@ortho/logger';
import db from '../db.js';
import { env } from '../env.js';
import * as reportConfigsRepo from '../repositories/report-configs.js';
import * as runsRepo from '../repositories/runs.js';
import { getMetrics } from './metrics-cache.js';
import { generatePdf, type ReportType } from './pdf-generator.js';
import { generateCsv } from './csv-generator.js';
import { sendReportEmail } from './email-sender.js';

const log = createLogger('crm-reporting');

// Sentinel UUID used as uploaded_by for Media Service internal store calls
export const SERVICE_CALLER_ID = '00000000-0000-0000-0000-000000reporting';

export interface GenerateReportJob {
  report_config_id: string;
  report_run_id: string;
  format: 'pdf' | 'csv';
  recipient_emails?: string[];
  report_schedule_id?: string;
}

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolves the report_config parameters period_type into a concrete
 * YYYY-MM-DD/YYYY-MM-DD range string suitable for Analytics Service calls.
 */
function resolvePeriod(parameters: Record<string, unknown>): string {
  const periodType = parameters['period_type'] as string | undefined;
  const now = new Date();

  if (periodType === 'custom') {
    const from = parameters['from'] as string;
    const to = parameters['to'] as string;
    return `${from}/${to}`;
  }

  if (periodType === 'last_30d') {
    const to = formatDate(now);
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - 30);
    return `${formatDate(fromDate)}/${to}`;
  }

  if (periodType === 'last_month') {
    const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 1);
    const firstOfPrevMonth = new Date(
      lastOfPrevMonth.getFullYear(),
      lastOfPrevMonth.getMonth(),
      1,
    );
    return `${formatDate(firstOfPrevMonth)}/${formatDate(lastOfPrevMonth)}`;
  }

  // Fallback: last 30 days
  const to = formatDate(now);
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  return `${formatDate(fromDate)}/${to}`;
}

// ---------------------------------------------------------------------------
// Media Service upload (multipart)
// ---------------------------------------------------------------------------

async function uploadToMediaService(
  buffer: Buffer,
  filename: string,
  contentType: string,
  locationId: string | null,
): Promise<{ file_id: string; url: string }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  form.append('tier', 'private');
  if (locationId !== null) {
    form.append('location_id', locationId);
  }
  form.append('purpose', 'report');

  const res = await fetch(`${env.MEDIA_SERVICE_URL}/media/internal/store`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.INTERNAL_API_SECRET}`,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Media Service error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { file_id: string; urls: { original: string } };
  return { file_id: data.file_id, url: data.urls.original };
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

async function publishNotification(
  triggeredBy: string,
  reportName: string,
  runId: string,
): Promise<void> {
  // channel must be 3 segments: user:{id}:{type}
  const res = await fetch(`${env.NOTIFICATION_SERVICE_URL}/notifications/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.INTERNAL_API_SECRET}`,
    },
    body: JSON.stringify({
      channel: `user:${triggeredBy}:reports`,
      title: 'Report Ready',
      body: `${reportName} is ready to download`,
      payload: { run_id: runId },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Log but do not throw — notification failure should not fail the run
    log.warn(
      { status: res.status, responseBody: text },
      'Notification Service publish failed',
    );
  }
}

// ---------------------------------------------------------------------------
// Main rendering pipeline
// ---------------------------------------------------------------------------

/**
 * Executes the full report rendering pipeline:
 *   1. Load report_config
 *   2. Resolve period
 *   3. Fetch metrics (via LRU cache)
 *   4. Generate PDF or CSV buffer
 *   5. Upload to Media Service (private tier)
 *   6. Mark run done
 *   7. Send delivery email if recipient_emails present
 *   8. Notify requesting user if on-demand (report_schedule_id absent)
 *
 * On any failure: marks run as failed with error_message and rethrows.
 */
export async function renderReport(job: GenerateReportJob): Promise<void> {
  const { report_config_id, report_run_id, format, recipient_emails, report_schedule_id } =
    job;

  try {
    // Step 1: Load report config
    const config = await reportConfigsRepo.findById(db, report_config_id);
    if (!config) {
      throw new Error(`Report config not found: ${report_config_id}`);
    }
    const parameters = config.parameters;

    // Step 2: Resolve period
    const period = resolvePeriod(parameters);

    // Step 3: Fetch metrics via cache
    const locationIds = (parameters['location_ids'] as string[] | undefined) ?? [];
    const metrics = await getMetrics('report', {
      period,
      location_ids: locationIds.length > 0 ? locationIds : undefined,
    });

    // Step 4: Generate document buffer
    const reportType = config.report_type as ReportType;
    const data: Record<string, unknown> = {
      ...metrics,
      period,
      report_name: config.name,
      location_ids: locationIds,
    };

    let buffer: Buffer;
    let filename: string;
    let contentType: string;

    if (format === 'pdf') {
      buffer = await generatePdf(reportType, data);
      filename = `${config.report_type}-${period.replace('/', '_')}.pdf`;
      contentType = 'application/pdf';
    } else {
      buffer = await generateCsv(reportType, data);
      filename = `${config.report_type}-${period.replace('/', '_')}.csv`;
      contentType = 'text/csv';
    }

    // Step 5: Upload to Media Service
    const locationId = locationIds.length === 1 ? (locationIds[0] ?? null) : null;
    const { file_id } = await uploadToMediaService(buffer, filename, contentType, locationId);

    // Step 6: Mark run done
    await runsRepo.updateStatus(db, report_run_id, 'done', {
      media_file_id: file_id,
      completed_at: new Date(),
    });

    // Step 7: Email delivery
    if (recipient_emails && recipient_emails.length > 0) {
      await sendReportEmail(report_run_id, recipient_emails, config.name, period);
    }

    // Step 8: In-app notification for on-demand runs
    if (!report_schedule_id) {
      const run = await runsRepo.findById(db, report_run_id);
      if (run) {
        await publishNotification(run.triggered_by, config.name, report_run_id);
      }
    }
  } catch (err) {
    // Step 9: Mark run failed and rethrow
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      await runsRepo.updateStatus(db, report_run_id, 'failed', {
        error_message: errorMessage,
      });
    } catch (updateErr) {
      log.error({ updateErr }, 'Failed to update run status to failed');
    }
    throw err;
  }
}

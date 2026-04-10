import { format as formatCsv } from 'fast-csv';
import type { ReportType } from './pdf-generator.js';

// Re-export for convenience
export type { ReportType };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

type CsvRow = Record<string, unknown>;

async function rowsToBuffer(rows: CsvRow[]): Promise<Buffer> {
  const csvStream = formatCsv({ headers: true, writeBOM: true });
  const bufferPromise = streamToBuffer(csvStream);
  for (const row of rows) {
    csvStream.write(row);
  }
  csvStream.end();
  return bufferPromise;
}

// ---------------------------------------------------------------------------
// Per-report-type row extraction
// ---------------------------------------------------------------------------

function extractRows(reportType: ReportType, data: Record<string, unknown>): CsvRow[] {
  const raw = data.raw as Record<string, unknown> | undefined;

  switch (reportType) {
    case 'weekly_summary':
    case 'monthly_executive': {
      // Top-level KPI summary — single row
      return [
        {
          period: data.period ?? '',
          cost_per_lead: data.cost_per_lead ?? '',
          exam_conversion_rate: data.exam_conversion_rate ?? '',
          exam_show_rate: data.exam_show_rate ?? '',
          case_conversion_rate: data.case_conversion_rate ?? '',
          cost_per_exam: data.cost_per_exam ?? '',
          cost_per_case_start: data.cost_per_case_start ?? '',
          revenue_attributed: data.revenue_attributed ?? '',
          roas: data.roas ?? '',
          lead_response_time_seconds: data.lead_response_time ?? '',
          time_in_stage_seconds: data.time_in_stage ?? '',
        },
      ];
    }

    case 'channel_deep_dive': {
      // Per-channel rows
      const byChannel = (raw?.leads as { by_channel?: CsvRow[] })?.by_channel ?? [];
      const byConversion = (raw?.conversions as { by_channel?: CsvRow[] })?.by_channel ?? [];
      const byPlatform = (raw?.adSpend as { by_platform?: CsvRow[] })?.by_platform ?? [];

      const conversionMap = new Map<string, number>();
      for (const c of byConversion) {
        conversionMap.set(String(c['channel']), Number(c['count'] ?? 0));
      }

      // Mirrors CHANNEL_TO_PLATFORM in metrics-calculator.ts (kept local to avoid
      // pulling in the analytics-client transitive dependency in this module)
      const CHANNEL_TO_PLATFORM: Record<string, string> = {
        google_ads: 'google_ads',
        facebook: 'facebook_ads',
      };
      const spendMap = new Map<string, number>();
      for (const p of byPlatform) {
        spendMap.set(String(p['platform']), Number(p['total_spend'] ?? 0));
      }

      return byChannel.map((ch) => {
        const channelName = String(ch['channel']);
        const leads = Number(ch['count'] ?? 0);
        const conversions = conversionMap.get(channelName) ?? 0;
        const platform = CHANNEL_TO_PLATFORM[channelName];
        const spend = platform ? (spendMap.get(platform) ?? null) : null;
        return {
          period: data.period ?? '',
          channel: channelName,
          leads,
          conversions,
          ad_spend: spend ?? '',
          cost_per_lead: spend != null && leads > 0 ? spend / leads : '',
          cost_per_conversion: spend != null && conversions > 0 ? spend / conversions : '',
        };
      });
    }

    case 'coordinator_productivity': {
      // Per-coordinator rows
      const coordinators =
        (raw?.coordinators as { coordinators?: CsvRow[] })?.coordinators ?? [];
      return coordinators.map((c) => ({
        period: data.period ?? '',
        coordinator_id: c['coordinator_id'],
        stage_transitions: c['stage_transitions'],
        exams_booked: c['exams_booked'],
        conversions: c['conversions'],
        avg_response_time_seconds: c['avg_response_time_seconds'] ?? '',
        avg_time_in_stage_seconds: c['avg_time_in_stage_seconds'] ?? '',
      }));
    }

    case 'lead_source': {
      // Per-channel lead count rows
      const byChannel = (raw?.leads as { by_channel?: CsvRow[]; total?: number })?.by_channel ?? [];
      const totalLeads = (raw?.leads as { total?: number })?.total ?? 0;
      const byConversion = (raw?.conversions as { by_channel?: CsvRow[] })?.by_channel ?? [];
      const conversionMap = new Map<string, number>();
      for (const c of byConversion) {
        conversionMap.set(String(c['channel']), Number(c['count'] ?? 0));
      }
      return byChannel.map((ch) => {
        const channelName = String(ch['channel']);
        const leads = Number(ch['count'] ?? 0);
        const conversions = conversionMap.get(channelName) ?? 0;
        return {
          period: data.period ?? '',
          channel: channelName,
          leads,
          pct_of_total: totalLeads > 0 ? ((leads / totalLeads) * 100).toFixed(1) : '',
          conversions,
          conversion_rate: leads > 0 ? (conversions / leads).toFixed(4) : '',
        };
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serializes report data as a CSV Buffer using fast-csv.
 * Rows are selected based on reportType — each type has a different schema.
 * Returns a non-empty Buffer (BOM-prefixed UTF-8 CSV).
 */
export async function generateCsv(
  reportType: ReportType,
  data: Record<string, unknown>,
): Promise<Buffer> {
  const rows = extractRows(reportType, data);
  return rowsToBuffer(rows);
}

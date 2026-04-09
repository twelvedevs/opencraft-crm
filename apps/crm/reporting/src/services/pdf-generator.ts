import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportType =
  | 'weekly_summary'
  | 'monthly_executive'
  | 'channel_deep_dive'
  | 'coordinator_productivity'
  | 'lead_source';

// ---------------------------------------------------------------------------
// Handlebars helpers
// ---------------------------------------------------------------------------

Handlebars.registerHelper('formatNumber', (value: unknown) => {
  if (value == null || typeof value !== 'number') return '0';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
});

Handlebars.registerHelper('formatPct', (value: unknown) => {
  if (value == null || typeof value !== 'number') return '0.0';
  return (value * 100).toFixed(1);
});

Handlebars.registerHelper('formatDecimal', (value: unknown) => {
  if (value == null || typeof value !== 'number') return '0.00';
  return value.toFixed(2);
});

Handlebars.registerHelper('formatSeconds', (value: unknown) => {
  if (value == null || typeof value !== 'number') return '—';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${(value / 3600).toFixed(1)}h`;
});

Handlebars.registerHelper('join', (arr: unknown, sep: string) => {
  if (!Array.isArray(arr)) return '';
  return arr.join(sep);
});

Handlebars.registerHelper('divOrNull', (a: unknown, b: unknown) => {
  if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return null;
  return a / b;
});

// ---------------------------------------------------------------------------
// Template loading — compiled at module initialization (fails fast if missing)
// ---------------------------------------------------------------------------

// Resolve templates/ directory relative to this source file, so the path works
// for both 'dist/services/pdf-generator.js' (compiled) and
// 'src/services/pdf-generator.ts' (tsx dev mode).
const TEMPLATES_DIR = path.join(
  fileURLToPath(new URL('../..', import.meta.url)),
  'templates',
);

const TEMPLATE_FILES: Record<ReportType, string> = {
  weekly_summary: 'weekly-summary.hbs',
  monthly_executive: 'monthly-executive.hbs',
  channel_deep_dive: 'channel-deep-dive.hbs',
  coordinator_productivity: 'coordinator-productivity.hbs',
  lead_source: 'lead-source.hbs',
};

// Load and compile all templates at import time — throws if any file is missing.
const COMPILED_TEMPLATES: Record<ReportType, HandlebarsTemplateDelegate> = (() => {
  const result = {} as Record<ReportType, HandlebarsTemplateDelegate>;
  for (const [reportType, filename] of Object.entries(TEMPLATE_FILES) as [
    ReportType,
    string,
  ][]) {
    const filePath = path.join(TEMPLATES_DIR, filename);
    const source = readFileSync(filePath, 'utf8');
    result[reportType] = Handlebars.compile(source);
  }
  return result;
})();

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

/**
 * Renders the Handlebars template for the given report type with data, then
 * launches a Puppeteer browser to produce a PDF Buffer.
 *
 * A new browser is created per job call. The browser is always closed in the
 * finally block regardless of success or failure.
 */
export async function generatePdf(
  reportType: ReportType,
  data: Record<string, unknown>,
): Promise<Buffer> {
  const html = COMPILED_TEMPLATES[reportType](data);

  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

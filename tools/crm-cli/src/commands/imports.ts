import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { request, uploadFile } from '../client.js';
import { printJson, printTable, printKeyValue, printSuccess, printError } from '../output.js';
import { withGlobals, handleError, type GlobalOpts } from '../util.js';

// ── Types ────────────────────────────────────────────────────────────────────

const IMPORT_TYPES = ['active_patients','completed_patients','scheduled_appointments','no_shows'] as const;
type ImportType = typeof IMPORT_TYPES[number];

interface ImportRecord {
  id: string;
  location_id: string;
  import_type: string;
  status: string;
  file_name: string;
  row_count: number | null;
  matched_count: number | null;
  unmatched_count: number | null;
  ambiguous_count: number | null;
  executed_count: number | null;
  failed_count: number | null;
  column_mapping: Record<string, string> | null;
  detected_headers: string[] | null;
  error_message: string | null;
  undo_deadline: string | null;
  created_at: string;
  [key: string]: unknown;
}

interface ImportRow {
  id: string;
  row_number: number;
  status: string;
  match_tier: number | null;
  matched_lead_id: string | null;
  raw_data: Record<string, unknown>;
  error_message: string | null;
}

// ── Exported formatters (unit-testable) ──────────────────────────────────────

const STATUS_COLORS: Record<string, (s: string) => string> = {
  completed:     chalk.green,
  preview_ready: chalk.cyan,
  executing:     chalk.yellow,
  uploading:     chalk.yellow,
  parsing:       chalk.yellow,
  undoing:       chalk.yellow,
  undone:        chalk.gray,
  cancelled:     chalk.gray,
  failed:        chalk.red,
};

export function formatImportStatus(status: string): string {
  return (STATUS_COLORS[status] ?? ((s: string) => s))(status);
}

export function formatCount(n: number | null): string {
  return n == null ? '—' : String(n);
}

// ── Poll helper ──────────────────────────────────────────────────────────────

async function pollUntil(
  id: string,
  done: (status: string) => boolean,
  opts: Pick<GlobalOpts, 'token' | 'url'>,
  intervalMs = 2000,
): Promise<ImportRecord> {
  process.stdout.write('Waiting');
  for (;;) {
    await new Promise(r => setTimeout(r, intervalMs));
    const imp = await request(`/imports/${id}`, { token: opts.token, gatewayUrl: opts.url }) as ImportRecord;
    if (done(imp.status)) { process.stdout.write(' done\n'); return imp; }
    if (imp.status === 'failed') { process.stdout.write('\n'); throw new Error(imp.error_message ?? 'Import failed'); }
    process.stdout.write('.');
  }
}

// ── Command registration ─────────────────────────────────────────────────────

export function registerImportsCommands(program: Command): void {
  const imports = program.command('imports').description('Manage CSV data imports');

  // ── upload ──────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('upload')
      .description('Upload a CSV file for import')
      .requiredOption('--file <path>',   'Path to CSV file')
      .requiredOption('--location <id>', 'Location UUID')
      .requiredOption('--type <type>',   `Import type: ${IMPORT_TYPES.join(' | ')}`)
      .option('--wait',                  'Poll until preview_ready, then show summary'),
  ).action(async (opts: GlobalOpts & { file: string; location: string; type: string; wait?: boolean }) => {
    try {
      if (!IMPORT_TYPES.includes(opts.type as ImportType)) {
        printError(`--type must be one of: ${IMPORT_TYPES.join(', ')}`); process.exit(1);
      }
      const csv  = readFileSync(opts.file);
      const form = new FormData();
      form.append('location_id',  opts.location);
      form.append('import_type',  opts.type);
      form.append('file', new Blob([csv], { type: 'text/csv' }), basename(opts.file));

      const imp = await uploadFile('/imports/upload', form, { token: opts.token, gatewayUrl: opts.url }) as ImportRecord;
      if (opts.json) { printJson(imp); return; }
      printSuccess(`Upload accepted  id: ${imp.id}  status: ${formatImportStatus(imp.status)}`);

      if (opts.wait) {
        const ready = await pollUntil(imp.id, s => s === 'preview_ready', opts);
        printKeyValue({
          id:              ready.id,
          status:          formatImportStatus(ready.status),
          rows:            formatCount(ready.row_count),
          matched:         formatCount(ready.matched_count),
          unmatched:       formatCount(ready.unmatched_count),
          ambiguous:       formatCount(ready.ambiguous_count),
          column_mapping:  JSON.stringify(ready.column_mapping ?? {}),
        }, 'Import Preview');
        console.log(`\nRun: crm imports confirm ${ready.id}  (or cancel to abort)`);
      }
    } catch (err) { handleError(err); }
  });

  // ── list ────────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('list')
      .description('List imports for a location')
      .requiredOption('--location <id>', 'Location UUID')
      .option('--type <type>',   'Filter by import type')
      .option('--status <status>', 'Filter by status'),
  ).action(async (opts: GlobalOpts & { location: string; type?: string; status?: string }) => {
    try {
      const params = new URLSearchParams({ location_id: opts.location });
      if (opts.type)   params.set('import_type', opts.type);
      if (opts.status) params.set('status', opts.status);

      const body = await request(`/imports?${params}`, { token: opts.token, gatewayUrl: opts.url }) as { data: ImportRecord[] };
      if (opts.json) { printJson(body); return; }

      if (!body.data.length) { console.log('No imports found.'); return; }
      printTable(
        ['ID', 'Type', 'Status', 'Rows', 'Matched', 'Unmatched', 'Created'],
        body.data.map(i => [
          i.id.slice(0, 8) + '…',
          i.import_type,
          formatImportStatus(i.status),
          formatCount(i.row_count),
          formatCount(i.matched_count),
          formatCount(i.unmatched_count),
          new Date(i.created_at).toLocaleString(),
        ]),
      );
    } catch (err) { handleError(err); }
  });

  // ── get ─────────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('get <id>')
      .description('Show import detail'),
  ).action(async (id: string, opts: GlobalOpts) => {
    try {
      const imp = await request(`/imports/${id}`, { token: opts.token, gatewayUrl: opts.url }) as ImportRecord;
      if (opts.json) { printJson(imp); return; }
      printKeyValue({
        id:              imp.id,
        type:            imp.import_type,
        status:          formatImportStatus(imp.status),
        file:            imp.file_name,
        rows:            formatCount(imp.row_count),
        matched:         formatCount(imp.matched_count),
        unmatched:       formatCount(imp.unmatched_count),
        ambiguous:       formatCount(imp.ambiguous_count),
        executed:        formatCount(imp.executed_count),
        failed:          formatCount(imp.failed_count),
        undo_deadline:   imp.undo_deadline ? new Date(imp.undo_deadline).toLocaleString() : '—',
        error:           imp.error_message ?? '—',
        created:         new Date(imp.created_at).toLocaleString(),
      }, 'Import');
    } catch (err) { handleError(err); }
  });

  // ── rows ────────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('rows <id>')
      .description('List import rows (preview)')
      .option('--status <status>', 'Filter: matched | unmatched | ambiguous | failed | pending')
      .option('--limit <n>',       'Max rows to fetch (default 50)', '50'),
  ).action(async (id: string, opts: GlobalOpts & { status?: string; limit: string }) => {
    try {
      const params = new URLSearchParams({ limit: opts.limit });
      if (opts.status) params.set('status', opts.status);

      const body = await request(`/imports/${id}/rows?${params}`, { token: opts.token, gatewayUrl: opts.url }) as { data: ImportRow[]; nextCursor: number | null };
      if (opts.json) { printJson(body); return; }

      if (!body.data.length) { console.log('No rows found.'); return; }
      printTable(
        ['#', 'Status', 'Tier', 'Lead ID', 'Error'],
        body.data.map(r => [
          r.row_number,
          r.status,
          r.match_tier ?? '—',
          r.matched_lead_id ? r.matched_lead_id.slice(0, 8) + '…' : '—',
          r.error_message ?? '—',
        ]),
      );
      if (body.nextCursor) console.log(chalk.dim(`  … more rows (cursor: ${body.nextCursor})`));
    } catch (err) { handleError(err); }
  });

  // ── confirm ─────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('confirm <id>')
      .description('Confirm import and start execute phase')
      .option('--wait', 'Poll until completed, then show summary'),
  ).action(async (id: string, opts: GlobalOpts & { wait?: boolean }) => {
    try {
      // Fetch current import to get column_mapping
      const imp = await request(`/imports/${id}`, { token: opts.token, gatewayUrl: opts.url }) as ImportRecord;
      const mapping = imp.column_mapping ?? {};

      if (!opts.json) {
        console.log(chalk.bold('Column mapping to confirm:'));
        for (const [src, dst] of Object.entries(mapping)) {
          console.log(`  ${chalk.dim(src.padEnd(20))} → ${dst}`);
        }
        const answer = await select({
          message: 'Confirm and start execution?',
          choices: [{ value: 'yes', name: 'Yes — execute import' }, { value: 'no', name: 'No — cancel' }],
        });
        if (answer !== 'yes') { console.log('Aborted.'); return; }
      }

      const result = await request(`/imports/${id}/confirm`, {
        method: 'POST', body: { column_mapping: mapping }, token: opts.token, gatewayUrl: opts.url,
      }) as ImportRecord;
      if (opts.json) { printJson(result); return; }
      printSuccess(`Executing  id: ${result.id}  status: ${formatImportStatus(result.status)}`);

      if (opts.wait) {
        const done = await pollUntil(id, s => s === 'completed' || s === 'undone', opts);
        printKeyValue({
          status:   formatImportStatus(done.status),
          executed: formatCount(done.executed_count),
          failed:   formatCount(done.failed_count),
          undo_by:  done.undo_deadline ? new Date(done.undo_deadline).toLocaleString() : '—',
        }, 'Completed');
      }
    } catch (err) { handleError(err); }
  });

  // ── cancel ──────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('cancel <id>')
      .description('Cancel a preview_ready import'),
  ).action(async (id: string, opts: GlobalOpts) => {
    try {
      const result = await request(`/imports/${id}/cancel`, {
        method: 'POST', token: opts.token, gatewayUrl: opts.url,
      }) as ImportRecord;
      if (opts.json) { printJson(result); return; }
      printSuccess(`Cancelled  id: ${result.id}`);
    } catch (err) { handleError(err); }
  });

  // ── undo ────────────────────────────────────────────────────────────────
  withGlobals(
    imports.command('undo <id>')
      .description('Undo a completed import (within 2-hour window)')
      .option('--wait', 'Poll until undone'),
  ).action(async (id: string, opts: GlobalOpts & { wait?: boolean }) => {
    try {
      const result = await request(`/imports/${id}/undo`, {
        method: 'POST', token: opts.token, gatewayUrl: opts.url,
      }) as ImportRecord;
      if (opts.json) { printJson(result); return; }
      printSuccess(`Undo started  id: ${result.id}  status: ${formatImportStatus(result.status)}`);

      if (opts.wait) {
        const done = await pollUntil(id, s => s === 'undone', opts);
        printSuccess(`Undone  status: ${formatImportStatus(done.status)}`);
      }
    } catch (err) { handleError(err); }
  });
}

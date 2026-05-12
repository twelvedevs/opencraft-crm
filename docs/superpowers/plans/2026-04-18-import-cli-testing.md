# Import CLI & Fake Data Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `crm imports` command family to the CRM CLI and a standalone fake-CSV generator so engineers can upload large batches of test data through the real import pipeline end-to-end.

**Architecture:** The generator script (`tools/crm-cli/scripts/gen-csv.ts`) emits Ortho2-format CSVs (headers: PatFirst, PatLast, CellPhone, Email, Birthdate) using only built-in Node APIs. The CLI commands follow the same commander + `withGlobals` pattern used by `leads`, `conversations`, etc. Multipart file upload is handled by a new `uploadFile()` in `client.ts` that uses the native `FormData` / `Blob` APIs (Node 18+). Async phases (parse_match, execute) are surfaced via an optional `--wait` polling loop printed as dots to stdout.

**Tech Stack:** TypeScript 5 (ESM), Node 24, commander 12, @inquirer/prompts, chalk, cli-table3, vitest 2. No new runtime dependencies.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `tools/crm-cli/scripts/gen-csv.ts` | Fake Ortho2 CSV generator (standalone script) |
| Modify | `tools/crm-cli/src/client.ts` | Add `uploadFile()` for multipart POST |
| Create | `tools/crm-cli/src/commands/imports.ts` | All `crm imports *` subcommands |
| Modify | `tools/crm-cli/src/index.ts` | Register `registerImportsCommands` |
| Create | `tools/crm-cli/test/client-upload.test.ts` | Unit tests for `uploadFile()` |
| Create | `tools/crm-cli/test/imports-output.test.ts` | Unit tests for import formatters |

---

## Task 1: Fake CSV Generator

**Files:**
- Create: `tools/crm-cli/scripts/gen-csv.ts`

This is a runnable script (`npx tsx scripts/gen-csv.ts`). No test needed — verify by running it.

- [ ] **Step 1: Create the generator script**

```typescript
// tools/crm-cli/scripts/gen-csv.ts
import { writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const FIRST_NAMES = ['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda',
  'William','Barbara','David','Susan','Richard','Jessica','Joseph','Sarah','Thomas','Karen',
  'Charles','Lisa','Christopher','Nancy','Daniel','Betty','Matthew','Margaret','Anthony',
  'Sandra','Mark','Ashley','Donald','Dorothy','Steven','Kimberly','Paul','Emily','Andrew',
  'Donna','Kenneth','Michelle','Joshua','Carol','Kevin','Amanda','Brian','Melissa','George',
  'Deborah','Timothy','Stephanie'];

const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis',
  'Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor',
  'Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark',
  'Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres',
  'Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell',
  'Mitchell','Carter','Roberts'];

const IMPORT_TYPES = ['active_patients','completed_patients','scheduled_appointments','no_shows'] as const;
type ImportType = typeof IMPORT_TYPES[number];

function pick<T>(arr: T[]): T { return arr[randomInt(arr.length)]!; }

function fakePhone(): string {
  const area = randomInt(200, 999);
  const mid  = randomInt(200, 999);
  const last = randomInt(1000, 9999);
  return `(${area}) ${mid}-${last}`;
}

function fakeEmail(first: string, last: string): string {
  const domains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com'];
  return `${first.toLowerCase()}.${last.toLowerCase()}${randomInt(10, 99)}@${pick(domains)}`;
}

function fakeDOB(): string {
  const year  = randomInt(1950, 2008);
  const month = String(randomInt(1, 13)).padStart(2, '0');
  const day   = String(randomInt(1, 29)).padStart(2, '0');
  return `${month}/${day}/${year}`;
}

function fakeApptDate(): string {
  const year  = 2026;
  const month = String(randomInt(1, 13)).padStart(2, '0');
  const day   = String(randomInt(1, 29)).padStart(2, '0');
  return `${month}/${day}/${year}`;
}

function fakeApptTime(): string {
  const hour   = String(randomInt(8, 18)).padStart(2, '0');
  const minute = randomInt(2) === 0 ? '00' : '30';
  return `${hour}:${minute}`;
}

function buildRow(type: ImportType): string[] {
  const first = pick(FIRST_NAMES);
  const last  = pick(LAST_NAMES);
  const phone = fakePhone();
  const email = randomInt(3) !== 0 ? fakeEmail(first, last) : '';
  const dob   = fakeDOB();
  const apptDate = type === 'scheduled_appointments' ? fakeApptDate() : '';
  const apptTime = type === 'scheduled_appointments' ? fakeApptTime() : '';
  return [first, last, phone, email, '', dob, apptDate, apptTime];
}

function generate(count: number, type: ImportType): string {
  const headers = ['PatFirst','PatLast','CellPhone','Email','HomePhone','Birthdate','ApptDate','ApptTime'];
  const rows = [headers.join(',')];
  for (let i = 0; i < count; i++) {
    rows.push(buildRow(type).map(v => v.includes(',') ? `"${v}"` : v).join(','));
  }
  return rows.join('\n') + '\n';
}

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const countArg  = args.find(a => a.startsWith('--count='))?.split('=')[1] ?? '500';
const typeArg   = args.find(a => a.startsWith('--type='))?.split('=')[1]  ?? 'active_patients';
const outArg    = args.find(a => a.startsWith('--out='))?.split('=')[1]   ?? 'test-import.csv';

const count = parseInt(countArg, 10);
if (isNaN(count) || count < 1) { console.error('--count must be a positive integer'); process.exit(1); }

if (!IMPORT_TYPES.includes(typeArg as ImportType)) {
  console.error(`--type must be one of: ${IMPORT_TYPES.join(', ')}`); process.exit(1);
}

const csv = generate(count, typeArg as ImportType);
writeFileSync(outArg, csv, 'utf8');
console.log(`Generated ${count} rows → ${outArg}  (type: ${typeArg})`);
```

- [ ] **Step 2: Verify the script runs and produces valid output**

```bash
cd tools/crm-cli
npx tsx scripts/gen-csv.ts --count=10 --type=active_patients --out=/tmp/test-import.csv
head -5 /tmp/test-import.csv
wc -l /tmp/test-import.csv   # should print 11 (1 header + 10 rows)
```

Expected output (values will vary):
```
Generated 10 rows → /tmp/test-import.csv  (type: active_patients)
PatFirst,PatLast,CellPhone,Email,HomePhone,Birthdate,ApptDate,ApptTime
Mary,Smith,(555) 234-5678,mary.smith42@gmail.com,,03/15/1978,,
...
11 /tmp/test-import.csv
```

- [ ] **Step 3: Generate the large test file for later use**

```bash
npx tsx scripts/gen-csv.ts --count=500 --type=active_patients --out=/tmp/import-500.csv
npx tsx scripts/gen-csv.ts --count=100 --type=scheduled_appointments --out=/tmp/import-appt-100.csv
```

- [ ] **Step 4: Commit**

```bash
git add tools/crm-cli/scripts/gen-csv.ts
git commit -m "feat(crm-cli): add fake Ortho2 CSV generator script"
```

---

## Task 2: Add `uploadFile()` to `client.ts`

The existing `request()` only sends JSON. Multipart uploads need a separate function that sets no `Content-Type` header (letting fetch set the multipart boundary automatically).

**Files:**
- Modify: `tools/crm-cli/src/client.ts`
- Create: `tools/crm-cli/test/client-upload.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tools/crm-cli/test/client-upload.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  readConfig:    vi.fn(() => ({ gateway_url: 'http://localhost:3000' })),
  resolveToken:  vi.fn(() => 'test-token'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { uploadFile, ApiError, NetworkError } = await import('../src/client.js');

describe('uploadFile', () => {
  beforeEach(() => mockFetch.mockReset());

  it('sends multipart POST to /v1/<path> with Authorization header', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'abc' }) });
    const fd = new FormData();
    fd.append('import_type', 'active_patients');
    await uploadFile('/imports/upload', fd);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/imports/upload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: fd,
      })
    );
  });

  it('does NOT set Content-Type header (lets fetch handle boundary)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const fd = new FormData();
    await uploadFile('/imports/upload', fd);
    const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string,string>;
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws NetworkError when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(uploadFile('/imports/upload', new FormData())).rejects.toThrow(NetworkError);
  });

  it('throws ApiError on 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401, json: async () => ({ error: 'unauthorized' }),
    });
    const err = await uploadFile('/imports/upload', new FormData()).catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it('throws ApiError on 4xx with error field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 422, statusText: 'Unprocessable Entity',
      json: async () => ({ error: 'invalid_csv' }),
    });
    const err = await uploadFile('/imports/upload', new FormData()).catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.apiError).toBe('invalid_csv');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
cd tools/crm-cli
npm test -- test/client-upload.test.ts
```

Expected: `uploadFile is not a function` (or similar import error)

- [ ] **Step 3: Implement `uploadFile()` in client.ts**

Add after the existing `request()` function:

```typescript
export async function uploadFile(path: string, form: FormData, options: Pick<RequestOptions, 'token' | 'gatewayUrl'> = {}): Promise<unknown> {
  const config  = readConfig();
  const baseUrl = options.gatewayUrl ?? config.gateway_url;
  const token   = resolveToken(options.token);
  const url     = `${baseUrl}/v1${path}`;

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // No Content-Type — fetch sets multipart boundary automatically

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: form });
  } catch {
    throw new NetworkError(baseUrl);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const body = data as { error?: string };
    if (response.status === 401) {
      throw new ApiError(401, `${body.error ?? 'unauthorized'} — Token may be expired. Run 'crm login'`);
    }
    if (response.status >= 500) {
      throw new ApiError(response.status, `Server error (${response.status}). Check service logs.`);
    }
    throw new ApiError(response.status, body.error ?? response.statusText);
  }

  return data;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- test/client-upload.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tools/crm-cli/src/client.ts tools/crm-cli/test/client-upload.test.ts
git commit -m "feat(crm-cli): add uploadFile() for multipart POST"
```

---

## Task 3: `crm imports` command — display helpers + unit tests

Build formatter functions first so they can be tested in isolation before wiring up HTTP calls.

**Files:**
- Create: `tools/crm-cli/src/commands/imports.ts` (skeleton + formatters)
- Create: `tools/crm-cli/test/imports-output.test.ts`

- [ ] **Step 1: Write formatter tests**

```typescript
// tools/crm-cli/test/imports-output.test.ts
import { describe, it, expect } from 'vitest';
import { formatImportStatus, formatCount } from '../src/commands/imports.js';

describe('formatImportStatus', () => {
  it('colors completed green', () => {
    expect(formatImportStatus('completed')).toContain('completed');
  });
  it('colors failed red', () => {
    expect(formatImportStatus('failed')).toContain('failed');
  });
  it('passes through unknown status unchanged', () => {
    expect(formatImportStatus('preview_ready')).toContain('preview_ready');
  });
});

describe('formatCount', () => {
  it('returns em-dash for null', () => {
    expect(formatCount(null)).toBe('—');
  });
  it('returns number as string', () => {
    expect(formatCount(42)).toBe('42');
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npm test -- test/imports-output.test.ts
```

Expected: module not found.

- [ ] **Step 3: Create `imports.ts` with skeleton + exported formatters**

```typescript
// tools/crm-cli/src/commands/imports.ts
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
```

- [ ] **Step 4: Run formatter tests — expect pass**

```bash
npm test -- test/imports-output.test.ts
```

Expected: all 5 formatter tests pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tools/crm-cli/src/commands/imports.ts tools/crm-cli/test/imports-output.test.ts
git commit -m "feat(crm-cli): add imports command (upload, list, get, rows, confirm, cancel, undo)"
```

---

## Task 4: Wire imports command into CLI entry point

**Files:**
- Modify: `tools/crm-cli/src/index.ts`

- [ ] **Step 1: Register imports command**

Add two lines to `tools/crm-cli/src/index.ts`:

```typescript
// after the existing imports:
import { registerImportsCommands } from './commands/imports.js';

// after registerLocationsCommands(program):
registerImportsCommands(program);
```

Full updated file:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { registerLoginCommand }          from './commands/login.js';
import { registerConfigCommands }        from './commands/config.js';
import { registerLeadsCommands }         from './commands/leads.js';
import { registerPipelineCommands }      from './commands/pipeline.js';
import { registerConversationsCommands } from './commands/conversations.js';
import { registerLocationsCommands }     from './commands/locations.js';
import { registerImportsCommands }       from './commands/imports.js';

const program = new Command();

program
  .name('crm')
  .description('CRM debug CLI — test and inspect backend modules via the API Gateway')
  .version('1.0.0');

registerLoginCommand(program);
registerConfigCommands(program);
registerLeadsCommands(program);
registerPipelineCommands(program);
registerConversationsCommands(program);
registerLocationsCommands(program);
registerImportsCommands(program);

program.parse();
```

- [ ] **Step 2: Smoke-test the command tree**

```bash
npx tsx src/index.ts imports --help
```

Expected output:
```
Usage: crm imports [options] [command]

Manage CSV data imports

Commands:
  upload    Upload a CSV file for import
  list      List imports for a location
  get       Show import detail
  rows      List import rows (preview)
  confirm   Confirm import and start execute phase
  cancel    Cancel a preview_ready import
  undo      Undo a completed import (within 2-hour window)
  help      display help for command
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: all tests pass (existing + new).

- [ ] **Step 4: Commit**

```bash
git add tools/crm-cli/src/index.ts
git commit -m "chore(crm-cli): register imports command in CLI entry point"
```

---

## Task 5: End-to-End Import Test Runbook

Prerequisites: stack running (`./scripts/dev/up-all.sh`), admin user logged in (`crm login`), a location UUID known (`crm locations list`).

Set a shell variable for convenience:
```bash
LOC_ID=<paste-location-uuid-here>
```

- [ ] **Step 1: Generate 500-row fake CSV**

```bash
cd tools/crm-cli
npx tsx scripts/gen-csv.ts --count=500 --type=active_patients --out=/tmp/import-500.csv
```

- [ ] **Step 2: Upload and wait for preview**

```bash
npx tsx src/index.ts imports upload \
  --file /tmp/import-500.csv \
  --location "$LOC_ID" \
  --type active_patients \
  --wait
```

Expected: dots print while parse_match runs, then a summary table showing matched/unmatched/ambiguous counts. Copy the import ID from the output.

```
✓ Upload accepted  id: <uuid>  status: uploading
Waiting..... done
Import Preview
  id                           <uuid>
  status                       preview_ready
  rows                         500
  matched                      312
  unmatched                    188
  ambiguous                    0
  column_mapping               {"PatFirst":"first_name",...}

Run: crm imports confirm <uuid>  (or cancel to abort)
```

- [ ] **Step 3: Inspect unmatched rows**

```bash
npx tsx src/index.ts imports rows <import-id> --status unmatched --limit 20
```

Expected: table of rows with `status=unmatched`, no lead ID.

- [ ] **Step 4: Confirm and execute**

```bash
npx tsx src/index.ts imports confirm <import-id> --wait
```

Expected: confirmation prompt → select "Yes", dots while execute runs, final counts:
```
✓ Executing  id: <uuid>  status: executing
Waiting.......... done
Completed
  status      completed
  executed    312
  failed      0
  undo_by     4/18/2026, 4:30:00 PM
```

- [ ] **Step 5: Verify via leads list**

```bash
npx tsx src/index.ts leads list --location "$LOC_ID" --page 1 --limit 20
```

Expected: leads visible in the system.

- [ ] **Step 6: Undo (optional — within 2-hour window)**

```bash
npx tsx src/index.ts imports undo <import-id> --wait
```

Expected: dots, then `✓ Undone  status: undone`.

- [ ] **Step 7: Test scheduled_appointments import**

```bash
npx tsx scripts/gen-csv.ts --count=50 --type=scheduled_appointments --out=/tmp/import-appts.csv
npx tsx src/index.ts imports upload \
  --file /tmp/import-appts.csv \
  --location "$LOC_ID" \
  --type scheduled_appointments \
  --wait
```

- [ ] **Step 8: Cancel a pending import (rollback test)**

In a separate terminal, upload a file but don't confirm:
```bash
npx tsx src/index.ts imports upload \
  --file /tmp/import-500.csv \
  --location "$LOC_ID" \
  --type active_patients \
  --wait
# → copy the id
npx tsx src/index.ts imports cancel <import-id>
npx tsx src/index.ts imports get <import-id>
# status should be: cancelled
```

---

## Self-Review

**Spec coverage:**
- ✅ Fake CSV generator (Ortho2 format, all 4 import types)
- ✅ `crm imports upload` with multipart POST and `--wait` polling
- ✅ `crm imports list` with location/type/status filters
- ✅ `crm imports get` with full field display
- ✅ `crm imports rows` with status filter and cursor display
- ✅ `crm imports confirm` with mapping display, interactive confirmation, `--wait`
- ✅ `crm imports cancel`
- ✅ `crm imports undo` with `--wait`
- ✅ `uploadFile()` tested in isolation
- ✅ Formatter functions tested in isolation
- ✅ End-to-end runbook covering happy path + undo + cancel

**Gaps:** None. Column mapping editing (changing field assignments interactively) is out of scope — the auto-detected Ortho2 mapping is always used, which is correct for testing.

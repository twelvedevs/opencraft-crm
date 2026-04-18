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

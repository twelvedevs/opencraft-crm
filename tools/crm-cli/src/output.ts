import chalk from 'chalk';
import Table from 'cli-table3';

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printTable(headers: string[], rows: (string | number | null | undefined)[][]): void {
  const table = new Table({ head: headers.map(h => chalk.bold(h)) });
  for (const row of rows) {
    table.push(row.map(cell => (cell == null ? '' : String(cell))));
  }
  console.log(table.toString());
}

export function printKeyValue(data: Record<string, unknown>, title?: string): void {
  if (title) console.log(chalk.bold.underline(title));
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    const display = typeof value === 'object' ? JSON.stringify(value) : String(value);
    console.log(`  ${chalk.dim(key.padEnd(28))} ${display}`);
  }
}

export function printSuccess(message: string): void {
  console.log(`${chalk.green('✓')} ${message}`);
}

export function printError(message: string): void {
  console.error(`${chalk.red('✗')} ${message}`);
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  open:     chalk.green,
  active:   chalk.green,
  closed:   chalk.gray,
  archived: chalk.gray,
  lost:     chalk.red,
};

export function colorizeStatus(value: string): string {
  return (STATUS_COLORS[value.toLowerCase()] ?? ((s: string) => s))(value);
}

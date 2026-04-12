import { describe, it, expect, vi, beforeEach } from 'vitest';

// Suppress chalk color codes in tests by mocking chalk
vi.mock('chalk', () => ({
  default: {
    bold: Object.assign((s: string) => s, {
      underline: (s: string) => s,
    }),
    dim:   (s: string) => s,
    green: (s: string) => s,
    gray:  (s: string) => s,
    red:   (s: string) => s,
  },
}));

vi.mock('cli-table3', () => ({
  default: class {
    rows: string[][] = [];
    push(row: string[]) { this.rows.push(row); }
    toString() { return this.rows.map(r => r.join('|')).join('\n'); }
  },
}));

const { printJson, printTable, printSuccess, printError, printKeyValue, colorizeStatus } = await import('../src/output.js');

describe('output', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('printJson outputs pretty JSON', () => {
    printJson({ id: '123', name: 'Jane' });
    expect(logSpy).toHaveBeenCalledWith('{\n  "id": "123",\n  "name": "Jane"\n}');
  });

  it('printSuccess logs to stdout', () => {
    printSuccess('Done');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Done'));
  });

  it('printError logs to stderr', () => {
    printError('Oops');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Oops'));
  });

  it('printKeyValue renders key-value pairs', () => {
    printKeyValue({ id: '1', name: 'Jane' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('id'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Jane'));
  });

  it('colorizeStatus returns the value unchanged (mocked chalk)', () => {
    expect(colorizeStatus('open')).toBe('open');
    expect(colorizeStatus('lost')).toBe('lost');
    expect(colorizeStatus('unknown')).toBe('unknown');
  });

  it('printTable renders rows', () => {
    printTable(['Name', 'Age'], [['Jane', 30], ['Bob', null]]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('Jane');
    expect(output).toContain('30');
  });

  it('printTable handles empty rows', () => {
    printTable(['Name'], []);
    expect(logSpy).toHaveBeenCalled();
  });

  it('printKeyValue renders with title', () => {
    printKeyValue({ status: 'active' }, 'Details');
    expect(logSpy).toHaveBeenCalledWith('Details');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('active'));
  });

  it('printKeyValue skips null values', () => {
    logSpy.mockClear();
    printKeyValue({ a: 'yes', b: null, c: undefined });
    const calls = logSpy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('yes'))).toBe(true);
    expect(calls.some(c => c.includes('null'))).toBe(false);
  });
});

/**
 * Period validation and resolution helpers.
 *
 * Accepted formats:
 *   YYYY-MM                         → resolved to first/last day of that calendar month
 *   YYYY-MM-DD/YYYY-MM-DD           → explicit date range; validated, max 366 days
 */

export interface ResolvedPeriod {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  label: string; // original period string passed by caller
}

export interface PeriodError {
  error: 'invalid_period';
  message: string;
}

function padTwo(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Return the last day of a given year+month as a YYYY-MM-DD string. */
function lastDayOf(year: number, month: number): string {
  // Month is 1-based. new Date(year, month, 0) gives the last day of `month`.
  const d = new Date(Date.UTC(year, month, 0));
  return `${year}-${padTwo(month)}-${padTwo(d.getUTCDate())}`;
}

function isValidDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

function diffDays(from: string, to: string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Parse and validate a period string.
 * Returns a ResolvedPeriod on success, or a PeriodError on failure.
 */
export function parsePeriod(period: string): ResolvedPeriod | PeriodError {
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    if (m < 1 || m > 12) {
      return { error: 'invalid_period', message: `Invalid month in period: ${period}` };
    }
    const from = `${period}-01`;
    const to = lastDayOf(y, m);
    return { from, to, label: period };
  }

  // YYYY-MM-DD/YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(period)) {
    const [from, to] = period.split('/');
    if (!isValidDate(from)) {
      return { error: 'invalid_period', message: `Invalid start date: ${from}` };
    }
    if (!isValidDate(to)) {
      return { error: 'invalid_period', message: `Invalid end date: ${to}` };
    }
    if (from > to) {
      return { error: 'invalid_period', message: 'Start date must not be after end date' };
    }
    const days = diffDays(from, to);
    if (days > 366) {
      return { error: 'invalid_period', message: 'Custom period cannot exceed 366 days' };
    }
    return { from, to, label: period };
  }

  return { error: 'invalid_period', message: `Unrecognized period format: ${period}` };
}

export function isPeriodError(v: ResolvedPeriod | PeriodError): v is PeriodError {
  return (v as PeriodError).error === 'invalid_period';
}

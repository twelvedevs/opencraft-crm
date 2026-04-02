import { Type, type Static } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Typebox schemas
// ---------------------------------------------------------------------------

export const GranularitySchema = Type.Union([
  Type.Literal('daily'),
  Type.Literal('monthly'),
  Type.Literal('total'),
]);

export const SharedQuerySchema = Type.Object({
  period: Type.String(),
  granularity: Type.Optional(GranularitySchema),
  location_id: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 1000 })),
});

export type Granularity = Static<typeof GranularitySchema>;
export type SharedQuery = Static<typeof SharedQuerySchema>;

// ---------------------------------------------------------------------------
// Period parsing
// ---------------------------------------------------------------------------

const CALENDAR_MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RANGE_RE = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

export function parsePeriod(period: string): DateRange | null {
  if (CALENDAR_MONTH_RE.test(period)) {
    // YYYY-MM — full calendar month
    const [year, month] = period.split('-').map(Number);
    const start = `${period}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${period}-${String(lastDay).padStart(2, '0')}`;
    return { start, end };
  }

  const rangeMatch = DATE_RANGE_RE.exec(period);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    if (start <= end) return { start, end };
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Normalise location_id query param (string or array) to string[].
 */
export function toArray(val: string | string[] | undefined): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Build a date expression for SELECT and GROUP BY based on granularity.
 * Returns null for 'total' (no date grouping).
 */
export function dateExpr(granularity: Granularity): string | null {
  if (granularity === 'daily') return 'date::text';
  if (granularity === 'monthly') return "DATE_TRUNC('month', date)::date::text";
  return null; // total
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export function paginateMeta(total: number, page: number, pageSize: number): PaginationMeta {
  return {
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  };
}

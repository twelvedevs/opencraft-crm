import { describe, it, expect, vi } from 'vitest';
import { computeDelay } from '../../src/services/active-hours.js';
import type { ActiveHoursConfig } from '../../src/services/active-hours.js';
import type { ExecutionContext } from '../../src/services/field-interpolator.js';

const execCtx: ExecutionContext = {
  event_id: 'evt-1',
  execution_id: 'exec-1',
  rule_id: 'rule-1',
  rule_version: 1,
};

// Helper: event payload with a timezone field
function payload(tz: string) {
  return { clinic: { timezone: tz } };
}

// Config that resolves timezone from 'clinic.timezone'
function cfg(start: string, end: string): ActiveHoursConfig {
  return { start, end, timezone_field: 'clinic.timezone' };
}

// All "clock-time" tests use UTC so the wall-clock == UTC
const UTC_PAYLOAD = payload('UTC');

describe('computeDelay — inside window', () => {
  it('returns 0 when current time is inside [start, end)', () => {
    // UTC 14:00 is inside 09:00–17:00
    const now = new Date('2026-01-15T14:00:00Z');
    expect(computeDelay(cfg('09:00', '17:00'), UTC_PAYLOAD, execCtx, now)).toBe(0);
  });

  it('returns 0 when current time equals start exactly', () => {
    const now = new Date('2026-01-15T09:00:00Z');
    expect(computeDelay(cfg('09:00', '17:00'), UTC_PAYLOAD, execCtx, now)).toBe(0);
  });
});

describe('computeDelay — before window (same day)', () => {
  it('returns ms from current time to start on the same day', () => {
    // UTC 06:00, window 09:00–17:00 → delay = 3h = 10800000 ms
    const now = new Date('2026-01-15T06:00:00Z');
    const delay = computeDelay(cfg('09:00', '17:00'), UTC_PAYLOAD, execCtx, now);
    expect(delay).toBe(3 * 60 * 60 * 1000); // 10800000
  });

  it('returns correct ms when window is in the afternoon and current time is early morning', () => {
    // UTC 01:00, window 08:00–20:00 → delay = 7h = 25200000 ms
    const now = new Date('2026-01-15T01:00:00Z');
    const delay = computeDelay(cfg('08:00', '20:00'), UTC_PAYLOAD, execCtx, now);
    expect(delay).toBe(7 * 60 * 60 * 1000);
  });
});

describe('computeDelay — after window end (rolls to next day)', () => {
  it('returns ms from current time to start on the following day', () => {
    // UTC 18:00, window 09:00–17:00 → delay = (24-18+9)*h = 15h = 54000000 ms
    const now = new Date('2026-01-15T18:00:00Z');
    const delay = computeDelay(cfg('09:00', '17:00'), UTC_PAYLOAD, execCtx, now);
    expect(delay).toBe(15 * 60 * 60 * 1000); // 54000000
  });

  it('delay is at most 86400000 ms', () => {
    // Worst case: current time is 1 ms past end; start is same as end effectively
    // Use UTC 17:00:01, window 09:00–17:00 → delay ≈ 15h 59m 59s
    const now = new Date('2026-01-15T17:00:01Z');
    const delay = computeDelay(cfg('09:00', '17:00'), UTC_PAYLOAD, execCtx, now);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(86_400_000);
  });
});

describe('computeDelay — midnight-crossing window', () => {
  it('returns 0 when current time is after start (before midnight)', () => {
    // UTC 23:00 is inside [22:00, 06:00)
    const now = new Date('2026-01-15T23:00:00Z');
    expect(computeDelay(cfg('22:00', '06:00'), UTC_PAYLOAD, execCtx, now)).toBe(0);
  });

  it('returns 0 when current time is before end (after midnight)', () => {
    // UTC 05:00 is inside [22:00, 06:00)
    const now = new Date('2026-01-15T05:00:00Z');
    expect(computeDelay(cfg('22:00', '06:00'), UTC_PAYLOAD, execCtx, now)).toBe(0);
  });

  it('returns delay when current time is between end and start', () => {
    // UTC 10:00 is outside [22:00, 06:00) → delay to 22:00 = 12h = 43200000 ms
    const now = new Date('2026-01-15T10:00:00Z');
    const delay = computeDelay(cfg('22:00', '06:00'), UTC_PAYLOAD, execCtx, now);
    expect(delay).toBe(12 * 60 * 60 * 1000); // 43200000
  });
});

describe('computeDelay — start === end (always open)', () => {
  it('returns 0 immediately regardless of current time', () => {
    const now = new Date('2026-01-15T03:00:00Z');
    expect(computeDelay(cfg('09:00', '09:00'), UTC_PAYLOAD, execCtx, now)).toBe(0);
  });
});

describe('computeDelay — missing or invalid timezone', () => {
  it('falls back to UTC and returns a number when timezone field is missing', () => {
    // payload has no clinic.timezone field → rawTz is undefined
    const now = new Date('2026-01-15T06:00:00Z');
    const result = computeDelay(cfg('09:00', '17:00'), {}, execCtx, now);
    // Should not throw; returns numeric delay (3h in UTC)
    expect(typeof result).toBe('number');
    expect(result).toBe(3 * 60 * 60 * 1000);
  });

  it('falls back to UTC and returns a number when timezone is invalid', () => {
    const now = new Date('2026-01-15T06:00:00Z');
    const result = computeDelay(
      cfg('09:00', '17:00'),
      { clinic: { timezone: 'Invalid/Timezone' } },
      execCtx,
      now,
    );
    expect(typeof result).toBe('number');
    expect(result).toBe(3 * 60 * 60 * 1000);
  });

  it('falls back to UTC and returns a number when timezone is an empty string', () => {
    const now = new Date('2026-01-15T06:00:00Z');
    const result = computeDelay(
      cfg('09:00', '17:00'),
      { clinic: { timezone: '' } },
      execCtx,
      now,
    );
    expect(typeof result).toBe('number');
  });
});

describe('computeDelay — non-UTC timezone', () => {
  it('resolves time in the correct timezone (America/New_York, UTC-4 in EDT)', () => {
    // 2026-01-15 is in January = EST (UTC-5)
    // now = 2026-01-15T14:00:00Z = 09:00 EST
    // Window 09:00–17:00 EST → current time exactly at start → inside
    const now = new Date('2026-01-15T14:00:00Z');
    const result = computeDelay(
      cfg('09:00', '17:00'),
      payload('America/New_York'),
      execCtx,
      now,
    );
    expect(result).toBe(0);
  });

  it('computes correct delay in a non-UTC timezone', () => {
    // 2026-01-15T11:00:00Z = 06:00 EST (UTC-5)
    // Window 09:00–17:00 EST → before window → delay = 3h = 10800000 ms
    const now = new Date('2026-01-15T11:00:00Z');
    const result = computeDelay(
      cfg('09:00', '17:00'),
      payload('America/New_York'),
      execCtx,
      now,
    );
    expect(result).toBe(3 * 60 * 60 * 1000);
  });
});

describe('computeDelay — DST edge case (America/New_York)', () => {
  it('returns delay > 0 and ≤ 86400000 ms at a DST boundary', () => {
    // Spring forward: 2026-03-08 at 2:00 AM EST → 3:00 AM EDT (clocks skip 1h)
    // 2026-03-08T10:00:00Z = 6:00 AM EDT (UTC-4, after the transition at 07:00 UTC)
    // Window 08:00–17:00 EDT → before window (6:00 AM < 8:00 AM)
    // Delay ≈ 2h = 7200000 ms
    const now = new Date('2026-03-08T10:00:00Z');
    const delay = computeDelay(
      cfg('08:00', '17:00'),
      payload('America/New_York'),
      execCtx,
      now,
    );
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(86_400_000);
  });
});

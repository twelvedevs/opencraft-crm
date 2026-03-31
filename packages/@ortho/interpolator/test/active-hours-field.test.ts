import { describe, it, expect, vi } from 'vitest';
import { computeActiveHoursDelay, type ActiveHoursFieldConfig } from '../src/active-hours-field.js';

function cfg(start: string, end: string, tz_field = 'clinic.timezone'): ActiveHoursFieldConfig {
  return { start, end, timezone_field: tz_field };
}

function dataCtx(tz: string) {
  return { clinic: { timezone: tz } };
}

const templateCtx = { event_id: 'evt-1', rule_id: 'rule-1' };

describe('computeActiveHoursDelay', () => {
  it('returns 0 when inside the window', () => {
    const now = new Date('2026-01-15T14:00:00Z');
    expect(computeActiveHoursDelay(cfg('09:00', '17:00'), dataCtx('UTC'), templateCtx, now)).toBe(0);
  });

  it('returns delay when before the window', () => {
    // UTC 06:00, window 09:00–17:00 → 3h delay
    const now = new Date('2026-01-15T06:00:00Z');
    expect(computeActiveHoursDelay(cfg('09:00', '17:00'), dataCtx('UTC'), templateCtx, now)).toBe(
      3 * 60 * 60 * 1000,
    );
  });

  it('returns delay when after the window (rolls to next day)', () => {
    // UTC 18:00, window 09:00–17:00 → 15h delay
    const now = new Date('2026-01-15T18:00:00Z');
    expect(computeActiveHoursDelay(cfg('09:00', '17:00'), dataCtx('UTC'), templateCtx, now)).toBe(
      15 * 60 * 60 * 1000,
    );
  });

  it('resolves timezone from nested dataCtx path', () => {
    // 2026-01-15T14:00:00Z = 09:00 EST → exactly at start → inside window
    const now = new Date('2026-01-15T14:00:00Z');
    expect(
      computeActiveHoursDelay(cfg('09:00', '17:00'), dataCtx('America/New_York'), templateCtx, now),
    ).toBe(0);
  });

  it('computes correct delay in non-UTC timezone', () => {
    // 2026-01-15T11:00:00Z = 06:00 EST → 3h before 09:00 window
    const now = new Date('2026-01-15T11:00:00Z');
    expect(
      computeActiveHoursDelay(cfg('09:00', '17:00'), dataCtx('America/New_York'), templateCtx, now),
    ).toBe(3 * 60 * 60 * 1000);
  });

  it('falls back to UTC when timezone field is missing', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = new Date('2026-01-15T06:00:00Z');
    const result = computeActiveHoursDelay(cfg('09:00', '17:00'), {}, templateCtx, now);
    expect(result).toBe(3 * 60 * 60 * 1000);
    spy.mockRestore();
  });

  it('falls back to UTC when timezone is invalid', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = new Date('2026-01-15T06:00:00Z');
    const result = computeActiveHoursDelay(
      cfg('09:00', '17:00'),
      dataCtx('Invalid/Timezone'),
      templateCtx,
      now,
    );
    expect(result).toBe(3 * 60 * 60 * 1000);
    spy.mockRestore();
  });

  it('falls back to UTC when timezone is empty string', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = new Date('2026-01-15T06:00:00Z');
    const result = computeActiveHoursDelay(cfg('09:00', '17:00'), dataCtx(''), templateCtx, now);
    expect(typeof result).toBe('number');
    spy.mockRestore();
  });

  it('returns 0 when start === end (always open)', () => {
    const now = new Date('2026-01-15T03:00:00Z');
    expect(computeActiveHoursDelay(cfg('09:00', '09:00'), dataCtx('UTC'), templateCtx, now)).toBe(0);
  });

  it('handles midnight-crossing window', () => {
    // UTC 23:00 is inside [22:00, 06:00)
    const now = new Date('2026-01-15T23:00:00Z');
    expect(computeActiveHoursDelay(cfg('22:00', '06:00'), dataCtx('UTC'), templateCtx, now)).toBe(0);
  });

  it('uses custom timezone_field path', () => {
    const now = new Date('2026-01-15T14:00:00Z'); // 09:00 EST
    const data = { payload: { location_timezone: 'America/New_York' } };
    expect(
      computeActiveHoursDelay(
        cfg('09:00', '17:00', 'payload.location_timezone'),
        data,
        templateCtx,
        now,
      ),
    ).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeNextActiveWindowMs } from '../src/active-hours.js';

const DAY_MS = 86_400_000;

describe('computeNextActiveWindowMs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when time is inside window (08:00–20:00, now=10:00 in America/Chicago)', () => {
    // 2026-01-15T16:00:00Z = 10:00 CST (UTC-6 in January)
    const now = new Date('2026-01-15T16:00:00Z');
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/Chicago', now);
    expect(result).toBe(0);
  });

  it('returns exactly 3600000 ms when time is 1 hour before window start (08:00–20:00, now=07:00 in America/Chicago)', () => {
    // 2026-01-15T13:00:00Z = 07:00 CST (UTC-6)
    const now = new Date('2026-01-15T13:00:00Z');
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/Chicago', now);
    expect(result).toBe(3_600_000);
  });

  it('returns ms until 08:00 next day when time is after window end (08:00–20:00, now=21:00 in America/Chicago)', () => {
    // 2026-01-15T03:00:00Z = 21:00 CST (UTC-6)
    // ms until 08:00 next day = 11 hours = 39600000
    const now = new Date('2026-01-15T03:00:00Z');
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/Chicago', now);
    expect(result).toBe(39_600_000);
  });

  it('returns 0 when start === end regardless of current time', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    expect(computeNextActiveWindowMs({ start: '12:00', end: '12:00' }, 'UTC', now)).toBe(0);
  });

  it('does not throw on invalid timezone and returns a non-negative number', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'Not/ATimezone', now);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('midnight-crossing window: returns 0 when time=23:00 UTC (inside 22:00–06:00)', () => {
    const now = new Date('2026-01-15T23:00:00Z');
    const result = computeNextActiveWindowMs({ start: '22:00', end: '06:00' }, 'UTC', now);
    expect(result).toBe(0);
  });

  it('midnight-crossing window: returns 43200000 ms when time=10:00 UTC (until 22:00, 12 hours)', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    const result = computeNextActiveWindowMs({ start: '22:00', end: '06:00' }, 'UTC', now);
    expect(result).toBe(43_200_000);
  });

  it('DST edge: America/New_York, window 08:00–20:00, now=07:30 before window start → result > 0 and <= DAY_MS', () => {
    // Spring-forward 2026-03-08: at 2am EST (7am UTC) clocks jump to 3am EDT.
    // After 7am UTC, New York is EDT (UTC-4). 11:30 UTC = 07:30 EDT — before 08:00 window.
    const now = new Date('2026-03-08T11:30:00Z');
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/New_York', now);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(DAY_MS);
  });

  it('result is never negative and never exceeds DAY_MS for multiple time positions', () => {
    const config = { start: '09:00', end: '17:00' };
    const times = [
      '2026-01-15T06:00:00Z',
      '2026-01-15T10:00:00Z',
      '2026-01-15T15:00:00Z',
      '2026-01-15T18:00:00Z',
      '2026-01-15T23:59:59Z',
    ];
    for (const t of times) {
      const result = computeNextActiveWindowMs(config, 'UTC', new Date(t));
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(DAY_MS);
    }
  });

  it('invariant: delay is always >= 0 and < 24h across all window types and every hour UTC', () => {
    const windows = [
      { start: '08:00', end: '20:00' }, // typical day window
      { start: '22:00', end: '06:00' }, // midnight-crossing
      { start: '00:00', end: '23:59' }, // nearly all day
      { start: '23:59', end: '00:01' }, // narrow midnight-crossing
      { start: '00:00', end: '00:00' }, // always-open (start === end)
    ];
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      const now = new Date(`2026-01-15T${hh}:00:00Z`);
      for (const config of windows) {
        const result = computeNextActiveWindowMs(config, 'UTC', now);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(DAY_MS);
      }
    }
  });
});

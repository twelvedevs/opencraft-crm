import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeNextActiveWindowMs } from '@ortho/interpolator';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('active hours deferral decision logic', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when inside window — 10:00 AM New York time (08:00–20:00)', () => {
    // 2026-03-31 10:00 AM EDT = 14:00 UTC (NY is UTC-4 in DST)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T14:00:00Z'));
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/New_York');
    expect(result).toBe(0);
  });

  it('returns positive ms when outside window — 22:00 New York time (08:00–20:00)', () => {
    // 2026-03-31 22:00 EDT = 02:00 UTC next day
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T02:00:00Z'));
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/New_York');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(DAY_MS);
  });

  it('returns positive ms when just before window — 07:59 New York time (08:00–20:00)', () => {
    // 2026-03-31 07:59 EDT = 11:59 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T11:59:00Z'));
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/New_York');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(DAY_MS);
  });

  it('returns 0 at exact window start — 08:00 New York time exactly (08:00–20:00)', () => {
    // 2026-03-31 08:00 EDT = 12:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/New_York');
    expect(result).toBe(0);
  });

  it('returns positive ms at exact window end — 20:00 New York time exactly (08:00–20:00)', () => {
    // 2026-03-31 20:00 EDT = 00:00 UTC next day
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:00Z'));
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/New_York');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(DAY_MS);
  });

  it('returns positive ms outside window — 09:00 UTC = 01:00 LA time in standard time (08:00–20:00)', () => {
    // 2026-01-15 09:00 UTC = 01:00 PST (UTC-8 in standard time, January)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T09:00:00Z'));
    const result = computeNextActiveWindowMs({ start: '08:00', end: '20:00' }, 'America/Los_Angeles');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(DAY_MS);
  });
});

import { resolveValue } from './interpolate.js';
import { computeNextActiveWindowMs } from './active-hours.js';

export interface ActiveHoursFieldConfig {
  start: string;          // HH:MM 24-hour
  end: string;            // HH:MM 24-hour
  timezone_field: string; // dot-notation path resolved against dataCtx
}

/**
 * Resolves `timezone_field` from the data context using dual-context
 * interpolation, then delegates to `computeNextActiveWindowMs`.
 *
 * Designed for the Automation Engine pattern where the timezone is a
 * dot-notation path into the event payload (e.g. "payload.location_timezone").
 */
export function computeActiveHoursDelay(
  config: ActiveHoursFieldConfig,
  dataCtx: Record<string, unknown>,
  templateCtx: Record<string, unknown>,
  now: Date = new Date(),
): number {
  const rawTz = resolveValue(config.timezone_field, dataCtx, templateCtx);

  let timezone = 'UTC';
  if (typeof rawTz === 'string' && rawTz.trim() !== '') {
    const candidate = rawTz.trim();
    try {
      Intl.DateTimeFormat(undefined, { timeZone: candidate });
      timezone = candidate;
    } catch {
      console.warn(`[active-hours] Invalid timezone "${candidate}", falling back to UTC`);
    }
  } else {
    console.warn(`[active-hours] Missing timezone from field "${config.timezone_field}", falling back to UTC`);
  }

  return computeNextActiveWindowMs({ start: config.start, end: config.end }, timezone, now);
}

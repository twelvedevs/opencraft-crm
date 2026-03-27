import { type ExecutionContext, resolveValue } from './field-interpolator.js';

export type ActiveHoursConfig = {
  start: string; // HH:MM (24-hour)
  end: string;   // HH:MM (24-hour)
  timezone_field: string;
};

const DAY_MS = 86_400_000;

function parseHHMM(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h * 3600 + m * 60) * 1000;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getTimeOfDayMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  return (hour * 3600 + minute * 60 + second) * 1000 + date.getMilliseconds();
}

export function computeDelay(
  config: ActiveHoursConfig,
  eventPayload: Record<string, unknown>,
  execCtx: ExecutionContext,
  now: Date = new Date(),
): number {
  // Resolve timezone from event payload
  const rawTz = resolveValue(config.timezone_field, eventPayload, execCtx);
  let timezone = 'UTC';
  if (typeof rawTz === 'string' && rawTz.trim() !== '' && isValidTimezone(rawTz.trim())) {
    timezone = rawTz.trim();
  } else {
    console.warn(`[active-hours] Invalid or missing timezone "${String(rawTz)}", falling back to UTC`);
  }

  // start === end → always-open window
  if (config.start === config.end) {
    return 0;
  }

  const startMs = parseHHMM(config.start);
  const endMs = parseHHMM(config.end);
  const currentMs = getTimeOfDayMs(now, timezone);

  if (startMs <= endMs) {
    // Non-midnight-crossing window: [start, end)
    if (currentMs >= startMs && currentMs < endMs) return 0;
    if (currentMs < startMs) return startMs - currentMs;
    // currentMs >= endMs: roll to next day
    return DAY_MS - currentMs + startMs;
  } else {
    // Midnight-crossing window: [start, 24h) ∪ [0, end)
    if (currentMs >= startMs || currentMs < endMs) return 0;
    // endMs <= currentMs < startMs
    return startMs - currentMs;
  }
}

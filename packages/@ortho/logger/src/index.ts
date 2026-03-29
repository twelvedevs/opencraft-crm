import pino from 'pino';

export type Logger = pino.Logger;

/**
 * Creates a Pino logger with Datadog-compatible structured fields.
 * Supports `dd.trace_id` / `dd.span_id` injection when Datadog APM is active.
 */
export function createLogger(service: string): Logger {
  return pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        // Datadog expects a `status` field instead of `level`
        return { level: label, status: label };
      },
    },
  });
}

/** Module-level singleton logger for quick import. */
export const logger = createLogger('ortho');

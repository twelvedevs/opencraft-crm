import pino from 'pino';
export type Logger = pino.Logger;
/**
 * Creates a Pino logger with Datadog-compatible structured fields.
 * Supports `dd.trace_id` / `dd.span_id` injection when Datadog APM is active.
 */
export declare function createLogger(service: string): Logger;
/** Module-level singleton logger for quick import. */
export declare const logger: Logger;
//# sourceMappingURL=index.d.ts.map
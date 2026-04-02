import { createLogger } from '@ortho/logger';

const logger = createLogger('ai-context-injector');

const TAG_REGEX = /\{\{([^}]+)\}\}/g;
const MAX_DEPTH = 3;

function resolveValue(context: Record<string, unknown> | unknown[], path: string): unknown {
  const parts = path.split('.');

  if (parts.length > MAX_DEPTH) {
    logger.warn({ path }, 'Context path exceeds max depth of 3, treating as missing');
    return undefined;
  }

  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.toString();
}

export function injectContext(template: string, context: Record<string, unknown> | unknown[]): string {
  return template.replace(TAG_REGEX, (_match, key: string) => {
    const trimmedKey = key.trim();
    const value = resolveValue(context, trimmedKey);

    if (value === undefined || value === null) {
      logger.warn({ key: trimmedKey }, 'Missing context key, replacing with empty string');
      return '';
    }

    return formatValue(value);
  });
}

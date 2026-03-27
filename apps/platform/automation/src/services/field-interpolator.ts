export type ExecutionContext = {
  event_id: string;
  execution_id: string;
  rule_id: string;
  rule_version: number;
};

const DOT_PATH_RE = /^[a-zA-Z_][\w.]*$/;
const TEMPLATE_TOKEN_RE = /\{\{(\w+)\}\}/g;

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export function resolveValue(
  value: unknown,
  eventCtx: Record<string, unknown>,
  execCtx: ExecutionContext,
): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  if (DOT_PATH_RE.test(value)) {
    return getByPath(eventCtx, value);
  }

  if (TEMPLATE_TOKEN_RE.test(value)) {
    TEMPLATE_TOKEN_RE.lastIndex = 0;
    return value.replace(TEMPLATE_TOKEN_RE, (_match, key: string) => {
      const resolved = (execCtx as unknown as Record<string, unknown>)[key];
      return resolved !== undefined ? String(resolved) : `{{${key}}}`;
    });
  }

  return value;
}

function resolveAny(
  value: unknown,
  eventCtx: Record<string, unknown>,
  execCtx: ExecutionContext,
): unknown {
  if (typeof value === 'string') {
    return resolveValue(value, eventCtx, execCtx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveAny(item, eventCtx, execCtx));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveAny(v, eventCtx, execCtx);
    }
    return result;
  }
  return value;
}

export function resolveParams(
  params: Record<string, unknown>,
  eventCtx: Record<string, unknown>,
  execCtx: ExecutionContext,
): Record<string, unknown> {
  return resolveAny(params, eventCtx, execCtx) as Record<string, unknown>;
}

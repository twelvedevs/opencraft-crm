const DOT_PATH_RE = /^[a-zA-Z_][\w]*\.[\w.]*$/;
const TEMPLATE_TOKEN_RE = /\{\{(\w+)\}\}/g;

export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function interpolateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  if (DOT_PATH_RE.test(value)) {
    return getByPath(context, value);
  }

  // Use a fresh regex to avoid stale lastIndex bugs with global regex
  const tokenRe = new RegExp(TEMPLATE_TOKEN_RE.source, 'g');
  if (tokenRe.test(value)) {
    return value.replace(new RegExp(TEMPLATE_TOKEN_RE.source, 'g'), (match, key: string) => {
      return key in context ? String(context[key]) : match;
    });
  }

  return value;
}

export function interpolateFields(
  params: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? interpolateFields(item as Record<string, unknown>, context)
          : interpolateValue(item, context),
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = interpolateFields(value as Record<string, unknown>, context);
    } else {
      result[key] = interpolateValue(value, context);
    }
  }
  return result;
}

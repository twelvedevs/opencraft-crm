// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Requires one or more dotted segments — "context.phone" and "payload.lead.name"
// match, but "haiku", "payload", "a.", and "a..b" do not (treated as literals).
// Prevents accidental resolution of short literal strings or malformed paths.
const DOT_PATH_RE = /^[a-zA-Z_]\w*(\.\w+)+$/;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Single-context API  (used by Nurturing Engine)
//
// One merged context for both dot-notation paths and {{template}} tokens.
// Dot-paths require at least one dot to avoid treating short literal strings
// (e.g. "final") as path lookups.
// ---------------------------------------------------------------------------

export function interpolateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  if (DOT_PATH_RE.test(value)) {
    return getByPath(context, value);
  }

  return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in context ? String(context[key]) : match;
  });
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

// ---------------------------------------------------------------------------
// Dual-context API  (used by Automation Engine)
//
// Separate contexts: dataCtx for dot-notation paths, templateCtx for
// {{token}} replacement. Single-segment strings (no dot) are treated as
// literals — the dot requirement prevents accidental resolution of short
// strings like "haiku" or "payload".
// ---------------------------------------------------------------------------

export function resolveValue(
  value: unknown,
  dataCtx: Record<string, unknown>,
  templateCtx: Record<string, unknown>,
): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  if (DOT_PATH_RE.test(value)) {
    return getByPath(dataCtx, value);
  }

  return value.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const resolved = templateCtx[key];
    return resolved !== undefined ? String(resolved) : `{{${key}}}`;
  });
}

function resolveAny(
  value: unknown,
  dataCtx: Record<string, unknown>,
  templateCtx: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    return resolveValue(value, dataCtx, templateCtx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveAny(item, dataCtx, templateCtx));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveAny(v, dataCtx, templateCtx);
    }
    return result;
  }
  return value;
}

export function resolveParams(
  params: Record<string, unknown>,
  dataCtx: Record<string, unknown>,
  templateCtx: Record<string, unknown>,
): Record<string, unknown> {
  return resolveAny(params, dataCtx, templateCtx) as Record<string, unknown>;
}

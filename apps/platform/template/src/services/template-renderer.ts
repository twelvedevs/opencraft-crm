export type RenderResult =
  | { ok: true; value: string; warnings: string[] }
  | { ok: false; error: string };

const VALID_TAG_RE = /\{\{([\w.]+)\}\}/g;
const EMPTY_TAG_RE = /\{\{\s*\}\}/;

function resolveKey(context: Record<string, unknown>, rawKey: string): unknown {
  const key = rawKey.toLowerCase();
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: unknown = context;
  for (const part of parts) {
    // Array index segments treated as unknown
    if (/^\d+$/.test(part)) return undefined;
    if (current === null || typeof current !== 'object') return undefined;
    const lowercasedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      lowercasedObj[k.toLowerCase()] = v;
    }
    current = lowercasedObj[part];
  }
  return current;
}

export function renderString(template: string, context: Record<string, unknown>): RenderResult {
  // Malformed check: empty/whitespace-only tags
  if (EMPTY_TAG_RE.test(template)) {
    return { ok: false, error: 'Malformed merge tag in template content' };
  }

  const warnings: string[] = [];

  const rendered = template.replace(VALID_TAG_RE, (_match, key: string) => {
    const resolved = resolveKey(context, key);
    if (resolved === undefined || resolved === null) {
      warnings.push(key);
      return '';
    }
    return String(resolved);
  });

  // After replacing all valid tags, check for remaining unclosed {{
  if (rendered.includes('{{')) {
    return { ok: false, error: 'Malformed merge tag in template content' };
  }

  return { ok: true, value: rendered, warnings };
}

/**
 * Simple mustache-style template renderer.
 * Replaces {{key}} patterns with context values; missing keys render as empty string.
 */
export function renderTemplate(
  template: string,
  context: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return context[key] ?? '';
  });
}

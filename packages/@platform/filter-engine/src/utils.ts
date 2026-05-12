export function resolveField(entity: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = entity;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

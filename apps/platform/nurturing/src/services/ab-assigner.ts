export type AbTestConfig = {
  enabled: boolean;
  split: Record<string, number>;
};

export function assignVariant(abTest: AbTestConfig | null | undefined): string | null {
  if (abTest == null || abTest.enabled === false) return null;

  const entries = Object.entries(abTest.split);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);

  if (total === 0 || entries.length === 0) return null;

  const r = Math.random() * total;
  let acc = 0;
  for (const [key, weight] of entries) {
    acc += weight;
    if (r < acc) return key;
  }

  // Fallback (floating-point edge case): return last key with non-zero weight
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i][1] > 0) return entries[i][0];
  }

  return null;
}

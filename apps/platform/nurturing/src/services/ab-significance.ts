export interface AbVariantStats {
  enrollments: number;
  conversions: number;
}

export interface AbSignificanceResult {
  significant: boolean;
  winner: string | null;
  p_value: number;
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const result = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? result : -result;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export function computeAbSignificance(
  a: AbVariantStats,
  b: AbVariantStats,
  variantAName: string,
  variantBName: string,
): AbSignificanceResult {
  if (a.enrollments < 100 || b.enrollments < 100) {
    return { significant: false, winner: null, p_value: 1 };
  }

  const p1 = a.conversions / a.enrollments;
  const p2 = b.conversions / b.enrollments;

  const p_pool = (a.conversions + b.conversions) / (a.enrollments + b.enrollments);
  const se = Math.sqrt(p_pool * (1 - p_pool) * (1 / a.enrollments + 1 / b.enrollments));

  if (se === 0) {
    return { significant: false, winner: null, p_value: 1 };
  }

  const z = Math.abs(p1 - p2) / se;
  const p_value = 2 * (1 - normalCdf(z));

  const significant = p_value < 0.05;
  const winner = significant ? (p1 >= p2 ? variantAName : variantBName) : null;

  return { significant, winner, p_value };
}

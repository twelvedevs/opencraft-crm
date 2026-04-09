/**
 * Pure function to select A/B test winner based on open rates.
 */
export function selectWinner(
  opensA: number,
  countA: number,
  opensB: number,
  countB: number,
): 'A' | 'B' {
  const rateA = countA > 0 ? opensA / countA : 0;
  const rateB = countB > 0 ? opensB / countB : 0;
  return rateB > rateA ? 'B' : 'A';
}

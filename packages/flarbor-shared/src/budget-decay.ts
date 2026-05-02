/**
 * Budget decay scoring curve.
 *
 * Returns 1.0 when `used <= budget`, linearly decays to 0.0 at `2 * budget`,
 * and clamps to [0, 1].
 *
 * Used by reward criteria that measure whether an agent stayed within a
 * budget (token budget, step budget, diff size, etc.).
 */
export function budgetDecay(used: number, budget: number): number {
  if (budget <= 0) return 0;
  if (used <= budget) return 1.0;
  if (used >= budget * 2) return 0.0;
  return 1.0 - (used - budget) / budget;
}

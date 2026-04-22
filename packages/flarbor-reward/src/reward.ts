import type {
  AggregationStrategy,
  Criterion,
  CriterionContext,
  CriterionResult,
  Reward,
  RewardScore,
} from "./types.js";

/**
 * Options for creating a reward.
 */
export interface RewardOptions {
  /** Reward name (e.g. "correctness", "quality") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** How to aggregate criterion scores (default: weighted_mean) */
  aggregation?: AggregationStrategy;
  /** Criteria in this group */
  criteria: Criterion[];
}

/**
 * Create a reward (named group of criteria).
 *
 * @example
 * ```typescript
 * const correctness = reward({
 *   name: "correctness",
 *   criteria: [
 *     fileExists("output.txt"),
 *     fileContains("output.txt", "expected result"),
 *     trialSuccess(3.0),
 *   ],
 * });
 * ```
 *
 * @example All-pass aggregation
 * ```typescript
 * const strictness = reward({
 *   name: "strictness",
 *   aggregation: "all_pass",
 *   criteria: [
 *     fileExists("a.txt"),
 *     fileExists("b.txt"),
 *   ],
 * });
 * ```
 */
export function reward(opts: RewardOptions): Reward {
  return {
    name: opts.name,
    description: opts.description,
    criteria: opts.criteria,
    aggregation: opts.aggregation ?? "weighted_mean",
  };
}

/**
 * Evaluate a single criterion, catching errors.
 */
async function evaluateCriterion(
  c: Criterion,
  ctx: CriterionContext,
): Promise<CriterionResult> {
  try {
    const raw = await c.evaluate(ctx);
    const score = typeof raw === "boolean" ? (raw ? 1.0 : 0.0) : raw;
    return {
      name: c.name,
      score: Math.max(0, Math.min(1, score)),
      weight: c.weight,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: c.name,
      score: 0,
      weight: c.weight,
      error: message,
    };
  }
}

/**
 * Aggregate criterion results using the specified strategy.
 */
function aggregate(
  results: CriterionResult[],
  strategy: AggregationStrategy,
): number {
  if (results.length === 0) return 0;

  switch (strategy) {
    case "weighted_mean": {
      let totalWeight = 0;
      let weightedSum = 0;
      for (const r of results) {
        weightedSum += r.score * r.weight;
        totalWeight += r.weight;
      }
      return totalWeight > 0 ? weightedSum / totalWeight : 0;
    }
    case "all_pass":
      return results.every((r) => r.score > 0) ? 1.0 : 0.0;
    case "any_pass":
      return results.some((r) => r.score > 0) ? 1.0 : 0.0;
    case "min":
      return Math.min(...results.map((r) => r.score));
    case "max":
      return Math.max(...results.map((r) => r.score));
  }
}

/**
 * Evaluate all criteria in a reward and produce a RewardScore.
 */
export async function evaluateReward(
  r: Reward,
  ctx: CriterionContext,
): Promise<RewardScore> {
  const strategy = r.aggregation ?? "weighted_mean";

  // Evaluate all criteria in parallel
  const results = await Promise.all(
    r.criteria.map((c) => evaluateCriterion(c, ctx)),
  );

  return {
    name: r.name,
    score: aggregate(results, strategy),
    criteria: results,
    aggregation: strategy,
  };
}

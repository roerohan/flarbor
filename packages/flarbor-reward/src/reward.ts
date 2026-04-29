import type {
  AggregationStrategy,
  Criterion,
  CriterionContext,
  CriterionResult,
  Reward,
  RewardScore,
} from "./types.js";

export interface RewardOptions {
  name: string;
  description?: string;
  aggregation?: AggregationStrategy;
  criteria: Criterion[];
}

export function reward(opts: RewardOptions): Reward {
  return {
    name: opts.name,
    description: opts.description,
    criteria: opts.criteria,
    aggregation: opts.aggregation ?? "weighted_mean",
  };
}

async function evaluateCriterion(c: Criterion, ctx: CriterionContext): Promise<CriterionResult> {
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
    return { name: c.name, score: 0, weight: c.weight, error: message };
  }
}

function aggregate(results: CriterionResult[], strategy: AggregationStrategy): number {
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

export async function evaluateReward(r: Reward, ctx: CriterionContext): Promise<RewardScore> {
  const strategy = r.aggregation ?? "weighted_mean";
  const results = await Promise.all(r.criteria.map((c) => evaluateCriterion(c, ctx)));

  return {
    name: r.name,
    score: aggregate(results, strategy),
    criteria: results,
    aggregation: strategy,
  };
}

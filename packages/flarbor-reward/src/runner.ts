import type {
  CriterionContext,
  Reward,
  RewardResult,
} from "./types.js";
import { evaluateReward } from "./reward.js";

/**
 * Run all rewards against a criterion context and produce a complete RewardResult.
 *
 * This is the main entry point for scoring a trial. Pass in the rewards
 * (groups of criteria) and the context (workspace, trial result, etc.),
 * and get back an overall score with full per-reward and per-criterion breakdowns.
 *
 * @example
 * ```typescript
 * import { run, reward } from "flarbor-reward";
 * import { fileExists, trialSuccess, tokenBudget } from "flarbor-reward";
 *
 * const result = await run(
 *   [
 *     reward({
 *       name: "correctness",
 *       criteria: [
 *         fileExists("output.txt"),
 *         trialSuccess(3.0),
 *       ],
 *     }),
 *     reward({
 *       name: "efficiency",
 *       criteria: [
 *         tokenBudget(50000),
 *       ],
 *     }),
 *   ],
 *   {
 *     workspace,
 *     filesChanged: trialResult.filesChanged,
 *     success: trialResult.success,
 *     usage: trialResult.usage,
 *   },
 * );
 *
 * console.log(result.score);       // 0.85
 * console.log(result.rewards);     // [{ name: "correctness", score: 0.9, ... }, ...]
 * ```
 */
export async function run(
  rewards: Reward[],
  ctx: CriterionContext,
): Promise<RewardResult> {
  if (rewards.length === 0) {
    return {
      score: 0,
      rewards: [],
      totalCriteria: 0,
      errors: 0,
    };
  }

  // Evaluate all rewards in parallel
  const rewardScores = await Promise.all(
    rewards.map((r) => evaluateReward(r, ctx)),
  );

  // Overall score is the mean of all reward scores (equally weighted)
  const overallScore =
    rewardScores.reduce((sum, r) => sum + r.score, 0) / rewardScores.length;

  // Count totals
  let totalCriteria = 0;
  let errors = 0;
  for (const rs of rewardScores) {
    for (const cr of rs.criteria) {
      totalCriteria++;
      if (cr.error) errors++;
    }
  }

  return {
    score: overallScore,
    rewards: rewardScores,
    totalCriteria,
    errors,
  };
}

import type { CriterionContext, Reward, RewardResult } from "./types.js";
import { evaluateReward } from "./reward.js";

/**
 * Score a trial by evaluating all rewards against the given context.
 * Returns an overall score with per-reward and per-criterion breakdowns.
 */
export async function run(rewards: Reward[], ctx: CriterionContext): Promise<RewardResult> {
  if (rewards.length === 0) {
    return { score: 0, rewards: [], totalCriteria: 0, errors: 0 };
  }

  const rewardScores = await Promise.all(rewards.map((r) => evaluateReward(r, ctx)));

  const overallScore = rewardScores.reduce((sum, r) => sum + r.score, 0) / rewardScores.length;

  let totalCriteria = 0;
  let errors = 0;
  for (const rs of rewardScores) {
    for (const cr of rs.criteria) {
      totalCriteria++;
      if (cr.error) errors++;
    }
  }

  return { score: overallScore, rewards: rewardScores, totalCriteria, errors };
}

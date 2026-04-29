import { criterion } from "../criterion.js";
import type { Criterion, CriterionContext } from "../types.js";

/**
 * Returns 1.0 at or below budget, linearly decays to 0.0 at 2x budget.
 */
export function tokenBudget(maxTokens: number, weight?: number): Criterion {
  return criterion({
    name: `token_budget:${maxTokens}`,
    description: `Used at most ${maxTokens} total tokens`,
    weight,
    evaluate: (ctx: CriterionContext) => {
      if (!ctx.usage) return 1.0;
      const used = ctx.usage.totalTokens;
      if (used <= maxTokens) return 1.0;
      if (used >= maxTokens * 2) return 0.0;
      return 1.0 - (used - maxTokens) / maxTokens;
    },
  });
}

export function tokenEfficiency(weight?: number): Criterion {
  return criterion({
    name: "token_efficiency",
    description: "Ratio of output tokens to total tokens",
    weight,
    evaluate: (ctx: CriterionContext) => {
      if (!ctx.usage || ctx.usage.totalTokens === 0) return 0.5;
      return ctx.usage.outputTokens / ctx.usage.totalTokens;
    },
  });
}

export function trialSuccess(weight?: number): Criterion {
  return criterion({
    name: "trial_success",
    description: "Trial completed without errors",
    weight,
    evaluate: (ctx: CriterionContext) => ctx.success,
  });
}

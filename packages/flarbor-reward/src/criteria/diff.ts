import { globToRegex } from "flarbor-shared";
import { budgetDecay } from "flarbor-shared";
import { criterion } from "../criterion.js";
import type { Criterion, CriterionContext } from "../types.js";

export function hasChanges(weight?: number): Criterion {
  return criterion({
    name: "has_changes",
    description: "Agent made at least one change",
    weight,
    evaluate: (ctx: CriterionContext) => ctx.filesChanged.length > 0,
  });
}

/**
 * Returns 1.0 if within budget, linearly decays to 0.0 at 2x the budget.
 */
export function diffSize(maxFiles: number, weight?: number): Criterion {
  return criterion({
    name: `diff_size:${maxFiles}`,
    description: `Changed at most ${maxFiles} files`,
    weight,
    evaluate: (ctx: CriterionContext) => budgetDecay(ctx.filesChanged.length, maxFiles),
  });
}

export function diffTouchesOnly(allowedPatterns: string[], weight?: number): Criterion {
  return criterion({
    name: "diff_touches_only",
    description: `Changes only touch allowed paths: ${allowedPatterns.join(", ")}`,
    weight,
    evaluate: (ctx: CriterionContext) => {
      const regexes = allowedPatterns.map(globToRegex);
      for (const file of ctx.filesChanged) {
        if (!regexes.some((r) => r.test(file))) return false;
      }
      return true;
    },
  });
}

export function noDeletions(weight?: number): Criterion {
  return criterion({
    name: "no_deletions",
    description: "No files were deleted",
    weight,
    evaluate: async (ctx: CriterionContext) => {
      for (const file of ctx.filesChanged) {
        const content = await ctx.workspace.readFile(file);
        if (content === null) return false;
      }
      return true;
    },
  });
}

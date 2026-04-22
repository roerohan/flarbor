import { criterion } from "../criterion.js";
import type { Criterion, CriterionContext } from "../types.js";

/**
 * Agent completed within a step budget.
 * Returns 1.0 at or below budget, linearly decays to 0.0 at 2x budget.
 *
 * Requires `ctx.steps` and `ctx.maxSteps` to be set, or pass `maxSteps` directly.
 */
export function stepBudget(
  maxSteps?: number,
  weight?: number,
): Criterion {
  return criterion({
    name: "step_budget",
    description: "Agent completed within step budget",
    weight,
    evaluate: (ctx: CriterionContext) => {
      const budget = maxSteps ?? ctx.maxSteps;
      const used = ctx.steps;
      if (budget === undefined || used === undefined) return 1.0;
      if (used <= budget) return 1.0;
      if (used >= budget * 2) return 0.0;
      return 1.0 - (used - budget) / budget;
    },
  });
}

/**
 * Agent used a specific file (read or modified it).
 * Checks if the file appears in filesChanged.
 */
export function touchedFile(
  path: string,
  weight?: number,
): Criterion {
  return criterion({
    name: `touched_file:${path}`,
    description: `Agent modified "${path}"`,
    weight,
    evaluate: (ctx: CriterionContext) => ctx.filesChanged.includes(path),
  });
}

/**
 * Agent did not modify a specific file.
 */
export function didNotTouch(
  path: string,
  weight?: number,
): Criterion {
  return criterion({
    name: `did_not_touch:${path}`,
    description: `Agent did not modify "${path}"`,
    weight,
    evaluate: (ctx: CriterionContext) => !ctx.filesChanged.includes(path),
  });
}

/**
 * Agent changed at least N files.
 */
export function minFilesChanged(
  count: number,
  weight?: number,
): Criterion {
  return criterion({
    name: `min_files_changed:${count}`,
    description: `Agent changed at least ${count} files`,
    weight,
    evaluate: (ctx: CriterionContext) => ctx.filesChanged.length >= count,
  });
}

import { criterion } from "../criterion.js";
import type { Criterion, CriterionContext } from "../types.js";

/**
 * The agent changed files (non-empty diff).
 */
export function hasChanges(weight?: number): Criterion {
  return criterion({
    name: "has_changes",
    description: "Agent made at least one change",
    weight,
    evaluate: (ctx: CriterionContext) => ctx.filesChanged.length > 0,
  });
}

/**
 * The agent changed at most N files.
 * Penalizes overly broad changes. Returns 1.0 if within budget,
 * linearly decays to 0.0 at 2x the budget.
 */
export function diffSize(maxFiles: number, weight?: number): Criterion {
  return criterion({
    name: `diff_size:${maxFiles}`,
    description: `Changed at most ${maxFiles} files`,
    weight,
    evaluate: (ctx: CriterionContext) => {
      const count = ctx.filesChanged.length;
      if (count <= maxFiles) return 1.0;
      if (count >= maxFiles * 2) return 0.0;
      return 1.0 - (count - maxFiles) / maxFiles;
    },
  });
}

/**
 * All changed files match one of the allowed glob-like patterns.
 * Simple matching: `*` matches any segment, `**` matches any path.
 */
export function diffTouchesOnly(
  allowedPatterns: string[],
  weight?: number,
): Criterion {
  return criterion({
    name: "diff_touches_only",
    description: `Changes only touch allowed paths: ${allowedPatterns.join(", ")}`,
    weight,
    evaluate: (ctx: CriterionContext) => {
      for (const file of ctx.filesChanged) {
        const allowed = allowedPatterns.some((pattern) => {
          const regex = new RegExp(
            "^" +
              pattern
                .replace(/\*\*/g, "§§")
                .replace(/\*/g, "[^/]*")
                .replace(/§§/g, ".*") +
              "$",
          );
          return regex.test(file);
        });
        if (!allowed) return false;
      }
      return true;
    },
  });
}

/**
 * No files were deleted (only additions and modifications).
 */
export function noDeletions(weight?: number): Criterion {
  return criterion({
    name: "no_deletions",
    description: "No files were deleted",
    weight,
    evaluate: async (ctx: CriterionContext) => {
      // Check each changed file still exists
      for (const file of ctx.filesChanged) {
        const content = await ctx.workspace.readFile(file);
        if (content === null) return false;
      }
      return true;
    },
  });
}

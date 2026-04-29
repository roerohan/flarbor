import { criterion } from "../criterion.js";
import type { Criterion, CriterionContext } from "../types.js";

/** Duplicated from flarbor core to avoid a runtime dependency. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/\*\*/g, "\0GLOBSTAR\0")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\0GLOBSTAR\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

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
    evaluate: (ctx: CriterionContext) => {
      const count = ctx.filesChanged.length;
      if (count <= maxFiles) return 1.0;
      if (count >= maxFiles * 2) return 0.0;
      return 1.0 - (count - maxFiles) / maxFiles;
    },
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

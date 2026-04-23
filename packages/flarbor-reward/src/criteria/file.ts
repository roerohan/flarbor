import { criterion } from "../criterion.js";
import type { Criterion, CriterionContext } from "../types.js";

/**
 * File exists in the workspace.
 */
export function fileExists(path: string, weight?: number): Criterion {
  return criterion({
    name: `file_exists:${path}`,
    description: `File "${path}" exists`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const content = await ctx.workspace.readFile(path);
      return content !== null;
    },
  });
}

/**
 * File does not exist in the workspace.
 */
export function fileNotExists(path: string, weight?: number): Criterion {
  return criterion({
    name: `file_not_exists:${path}`,
    description: `File "${path}" does not exist`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const content = await ctx.workspace.readFile(path);
      return content === null;
    },
  });
}

/**
 * File contains a substring.
 */
export function fileContains(
  path: string,
  text: string,
  weight?: number,
): Criterion {
  return criterion({
    name: `file_contains:${path}`,
    description: `File "${path}" contains "${text.slice(0, 40)}"`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const content = await ctx.workspace.readFile(path);
      if (content === null) return false;
      return content.includes(text);
    },
  });
}

/**
 * File content matches a regex pattern.
 */
export function fileContainsRegex(
  path: string,
  pattern: string | RegExp,
  weight?: number,
): Criterion {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  return criterion({
    name: `file_contains_regex:${path}`,
    description: `File "${path}" matches pattern ${regex.source}`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const content = await ctx.workspace.readFile(path);
      if (content === null) return false;
      return regex.test(content);
    },
  });
}

/**
 * File content exactly equals expected text (whitespace-stripped).
 */
export function fileMatches(
  path: string,
  expected: string,
  weight?: number,
): Criterion {
  return criterion({
    name: `file_matches:${path}`,
    description: `File "${path}" matches expected content`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const content = await ctx.workspace.readFile(path);
      if (content === null) return false;
      return content.trim() === expected.trim();
    },
  });
}

/**
 * Two files have identical content.
 */
export function filesEqual(
  path1: string,
  path2: string,
  weight?: number,
): Criterion {
  return criterion({
    name: `files_equal:${path1}:${path2}`,
    description: `Files "${path1}" and "${path2}" are identical`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const [content1, content2] = await Promise.all([
        ctx.workspace.readFile(path1),
        ctx.workspace.readFile(path2),
      ]);
      if (content1 === null || content2 === null) return false;
      return content1 === content2;
    },
  });
}

/**
 * Similarity ratio between file content and expected text.
 * Returns 0.0 - 1.0 based on Levenshtein-like character overlap.
 */
export function diffRatio(
  path: string,
  expected: string,
  weight?: number,
): Criterion {
  return criterion({
    name: `diff_ratio:${path}`,
    description: `Similarity of "${path}" to expected content`,
    weight,
    evaluate: async (ctx: CriterionContext) => {
      const content = await ctx.workspace.readFile(path);
      if (content === null) return 0;
      const actual = content.trim();
      const exp = expected.trim();
      if (actual === exp) return 1.0;
      if (actual.length === 0 && exp.length === 0) return 1.0;

      // Simple character-level similarity (Sørensen–Dice coefficient on bigrams)
      const bigrams = (s: string): Set<string> => {
        const set = new Set<string>();
        for (let i = 0; i < s.length - 1; i++) {
          set.add(s.slice(i, i + 2));
        }
        return set;
      };
      const a = bigrams(actual);
      const b = bigrams(exp);
      let intersection = 0;
      for (const bg of a) {
        if (b.has(bg)) intersection++;
      }
      return (2 * intersection) / (a.size + b.size);
    },
  });
}

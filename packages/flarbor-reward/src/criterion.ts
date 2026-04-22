import type { Criterion, CriterionContext } from "./types.js";

/**
 * Options for creating a criterion.
 */
export interface CriterionOptions {
  /** Unique name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Weight in reward aggregation (default: 1.0) */
  weight?: number;
  /** The evaluation function */
  evaluate: (ctx: CriterionContext) => Promise<number | boolean> | number | boolean;
}

/**
 * Create a criterion from a function and metadata.
 *
 * @example
 * ```typescript
 * const hasReadme = criterion({
 *   name: "has_readme",
 *   description: "Repository has a README.md",
 *   evaluate: async (ctx) => {
 *     const content = await ctx.workspace.readFile("README.md");
 *     return content !== null;
 *   },
 * });
 * ```
 *
 * @example With weight
 * ```typescript
 * const testsPass = criterion({
 *   name: "tests_pass",
 *   weight: 3.0,
 *   evaluate: async (ctx) => ctx.success,
 * });
 * ```
 */
export function criterion(opts: CriterionOptions): Criterion {
  const evalFn = opts.evaluate;
  return {
    name: opts.name,
    description: opts.description,
    weight: opts.weight ?? 1.0,
    evaluate: async (ctx: CriterionContext) => {
      const result = evalFn(ctx);
      return result instanceof Promise ? result : result;
    },
  };
}

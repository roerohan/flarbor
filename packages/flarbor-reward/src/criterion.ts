import type { Criterion, CriterionContext } from "./types.js";

export interface CriterionOptions {
  name: string;
  description?: string;
  weight?: number;
  evaluate: (ctx: CriterionContext) => Promise<number | boolean> | number | boolean;
}

/**
 * Create a criterion from a function and metadata.
 * Synchronous evaluate functions are wrapped in a Promise automatically.
 */
export function criterion(opts: CriterionOptions): Criterion {
  const evalFn = opts.evaluate;
  return {
    name: opts.name,
    description: opts.description,
    weight: opts.weight ?? 1.0,
    evaluate: (ctx: CriterionContext) => Promise.resolve(evalFn(ctx)),
  };
}

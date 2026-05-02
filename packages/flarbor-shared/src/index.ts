export { globToRegex, matchesGlob } from "./glob.js";
export { budgetDecay } from "./budget-decay.js";
export { isTrialResult } from "./trial-result.js";
export { DispatchError, dispatchTask, agentNameFor } from "./dispatch.js";

export type {
  TokenUsage,
  CriterionContext,
  CriterionResult,
  AggregationStrategy,
  RewardScore,
  RewardResult,
  WorkspaceLike,
} from "./types.js";

export type { TrialResultShape } from "./trial-result.js";
export type { DispatchErrorKind, DispatchTaskConfig, FetcherLike } from "./dispatch.js";

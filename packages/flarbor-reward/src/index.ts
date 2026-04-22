// Runner — main entry point
export { run } from "./runner.js";

// Reward builder
export { reward, evaluateReward } from "./reward.js";

// Criterion builder
export { criterion } from "./criterion.js";

// LLM judge
export { judge } from "./judge.js";

// Built-in criteria: file
export {
  fileExists,
  fileNotExists,
  fileContains,
  fileContainsRegex,
  fileMatches,
  filesEqual,
  diffRatio,
} from "./criteria/file.js";

// Built-in criteria: diff
export {
  hasChanges,
  diffSize,
  diffTouchesOnly,
  noDeletions,
} from "./criteria/diff.js";

// Built-in criteria: token/efficiency
export {
  tokenBudget,
  tokenEfficiency,
  trialSuccess,
} from "./criteria/token.js";

// Built-in criteria: trajectory
export {
  stepBudget,
  touchedFile,
  didNotTouch,
  minFilesChanged,
} from "./criteria/trajectory.js";

// Types
export type {
  WorkspaceLike,
  TokenUsage,
  CriterionContext,
  Criterion,
  CriterionResult,
  AggregationStrategy,
  Reward,
  RewardScore,
  RewardResult,
  JudgeConfig,
} from "./types.js";

export type { CriterionOptions } from "./criterion.js";
export type { RewardOptions } from "./reward.js";

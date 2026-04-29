export { run } from "./runner.js";
export { reward, evaluateReward } from "./reward.js";
export { criterion } from "./criterion.js";
export { judge } from "./judge.js";

export {
  fileExists,
  fileNotExists,
  fileContains,
  fileContainsRegex,
  fileMatches,
  filesEqual,
  diffRatio,
} from "./criteria/file.js";

export {
  hasChanges,
  diffSize,
  diffTouchesOnly,
  noDeletions,
} from "./criteria/diff.js";

export {
  tokenBudget,
  tokenEfficiency,
  trialSuccess,
} from "./criteria/token.js";

export {
  stepBudget,
  touchedFile,
  didNotTouch,
  minFilesChanged,
} from "./criteria/trajectory.js";

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

export { FlarborEnvironment } from "./environment.js";
export { GitWorkspace } from "./workspace.js";
export { runTask } from "./agent-runner.js";

// Re-export from flarbor-shared so existing consumers don't break
export { globToRegex, matchesGlob } from "flarbor-shared";

export type {
  TaskConfig,
  TrialResult,
  GitConfig,
  EnvironmentConfig,
  FlarborEnv,
} from "./types.js";

export type {
  TokenUsage,
  RewardResult,
  RewardScore,
  CriterionResult,
  CriterionContext,
  AggregationStrategy,
} from "flarbor-shared";

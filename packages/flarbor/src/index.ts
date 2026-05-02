export { FlarborEnvironment } from "./environment.js";
export { GitWorkspace } from "./workspace.js";
export { runTask } from "./agent-runner.js";
export { agentNameFor } from "flarbor-shared";

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

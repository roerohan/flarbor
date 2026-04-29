import type { LanguageModel, ToolSet } from "ai";
import type { Session } from "agents/experimental/memory/session";

export interface TaskConfig {
  repoUrl: string;
  instructions: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  maxSteps?: number;
}

export interface TrialResult {
  success: boolean;
  branch: string;
  commitSha: string;
  filesChanged: string[];
  error?: string;
  usage?: TokenUsage;
  reward?: RewardResult;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Defined here so both flarbor and flarbor-reward share the same shape
 * without creating a package dependency cycle.
 */
export interface RewardResult {
  score: number;
  rewards: RewardScore[];
  totalCriteria: number;
  errors: number;
}

export type AggregationStrategy = "weighted_mean" | "all_pass" | "any_pass" | "min" | "max";

export interface RewardScore {
  name: string;
  score: number;
  criteria: CriterionResult[];
  aggregation: AggregationStrategy;
}

export interface CriterionResult {
  name: string;
  score: number;
  weight: number;
  error?: string;
}

export interface GitConfig {
  authorName: string;
  authorEmail: string;
}

/**
 * Domain-specific configuration provided by each environment subclass.
 * The library handles infrastructure; the environment provides everything else.
 */
export interface EnvironmentConfig {
  model: LanguageModel;
  systemPrompt: string;
  configureSession?: (session: Session) => Session | Promise<Session>;
  tools?: ToolSet;
  maxSteps?: number;
  protectedPaths?: string[];
  enableCodeExecution?: boolean;
}

export interface FlarborEnv {
  AI?: Ai;
  LOADER: WorkerLoader;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
}

import type { LanguageModel } from "ai";

export interface WorkspaceLike {
  readFile(path: string): Promise<string | null>;
  readDir(
    dir: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ path: string; type: string }[]>;
  glob?(pattern: string): Promise<{ path: string }[]>;
}

/**
 * Structurally identical to flarbor's TokenUsage — kept here so
 * flarbor-reward has no runtime dependency on the core package.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CriterionContext {
  workspace: WorkspaceLike;
  filesChanged: string[];
  success: boolean;
  usage?: TokenUsage;
  error?: string;
  steps?: number;
  maxSteps?: number;
  metadata?: Record<string, unknown>;
}

export interface Criterion {
  name: string;
  description?: string;
  weight: number;
  evaluate: (ctx: CriterionContext) => Promise<number | boolean>;
}

export interface CriterionResult {
  name: string;
  score: number;
  weight: number;
  error?: string;
}

export type AggregationStrategy = "weighted_mean" | "all_pass" | "any_pass" | "min" | "max";

export interface Reward {
  name: string;
  description?: string;
  criteria: Criterion[];
  aggregation?: AggregationStrategy;
}

export interface RewardScore {
  name: string;
  score: number;
  criteria: CriterionResult[];
  aggregation: AggregationStrategy;
}

export interface RewardResult {
  score: number;
  rewards: RewardScore[];
  totalCriteria: number;
  errors: number;
}

export interface JudgeConfig {
  model: LanguageModel;
  files: string[];
  prompt: string;
  type: "binary" | "likert" | "float";
  points?: number;
}

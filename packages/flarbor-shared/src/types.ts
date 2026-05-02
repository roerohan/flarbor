/**
 * Shared types used across flarbor, flarbor-reward, and flarbor-job packages.
 * These are the canonical definitions — all packages import from here.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CriterionResult {
  name: string;
  score: number;
  weight: number;
  error?: string;
}

export type AggregationStrategy = "weighted_mean" | "all_pass" | "any_pass" | "min" | "max";

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

export interface WorkspaceLike {
  readFile(path: string): Promise<string | null>;
  readDir(
    dir?: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ path: string; type: string }[]>;
  glob?(pattern: string): Promise<{ path: string }[]>;
}

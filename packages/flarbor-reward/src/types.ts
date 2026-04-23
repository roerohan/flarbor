import type { LanguageModel } from "ai";

/**
 * Minimal workspace interface for reading files.
 * Compatible with @cloudflare/shell Workspace.
 */
export interface WorkspaceLike {
  readFile(path: string): Promise<string | null>;
  readDir(
    dir: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ path: string; type: string }[]>;
  glob?(pattern: string): Promise<{ path: string }[]>;
}

/**
 * Token usage from a trial. Matches flarbor's TokenUsage.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Context passed to every criterion function.
 * Contains everything a criterion might need to score a trial.
 */
export interface CriterionContext {
  /** The workspace filesystem (for reading files the agent produced) */
  workspace: WorkspaceLike;
  /** Files changed by the agent */
  filesChanged: string[];
  /** Whether the agent reported success */
  success: boolean;
  /** Token usage across the trial */
  usage?: TokenUsage;
  /** Error message if the trial failed */
  error?: string;
  /** Number of agentic loop steps taken */
  steps?: number;
  /** Maximum steps allowed */
  maxSteps?: number;
  /** Arbitrary metadata from the task or trial */
  metadata?: Record<string, unknown>;
}

/**
 * A single scoring function with metadata.
 */
export interface Criterion {
  /** Unique name for this criterion */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Weight in the reward aggregation (default 1.0) */
  weight: number;
  /**
   * Evaluate this criterion. Returns a score between 0.0 and 1.0,
   * or a boolean (true = 1.0, false = 0.0).
   */
  evaluate: (ctx: CriterionContext) => Promise<number | boolean>;
}

/**
 * Result of evaluating a single criterion.
 */
export interface CriterionResult {
  /** Criterion name */
  name: string;
  /** Normalized score (0.0 - 1.0) */
  score: number;
  /** Weight used in aggregation */
  weight: number;
  /** Error if evaluation failed */
  error?: string;
}

/**
 * How to aggregate criterion scores within a reward.
 *
 * - `weighted_mean`: weighted average of all scores (default)
 * - `all_pass`: 1.0 if all scores > 0, else 0.0
 * - `any_pass`: 1.0 if any score > 0, else 0.0
 * - `min`: minimum score
 * - `max`: maximum score
 */
export type AggregationStrategy =
  | "weighted_mean"
  | "all_pass"
  | "any_pass"
  | "min"
  | "max";

/**
 * A named group of criteria with an aggregation strategy.
 * Equivalent to a subdirectory in Harbor's reward kit.
 */
export interface Reward {
  /** Reward name (e.g. "correctness", "quality", "efficiency") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Criteria in this reward group */
  criteria: Criterion[];
  /** How to combine criterion scores (default: weighted_mean) */
  aggregation?: AggregationStrategy;
}

/**
 * Result of evaluating a single reward (group of criteria).
 */
export interface RewardScore {
  /** Reward name */
  name: string;
  /** Aggregated score (0.0 - 1.0) */
  score: number;
  /** Per-criterion results */
  criteria: CriterionResult[];
  /** Aggregation strategy used */
  aggregation: AggregationStrategy;
}

/**
 * Complete result of scoring a trial.
 */
export interface RewardResult {
  /** Overall score (weighted mean of all reward scores) */
  score: number;
  /** Per-reward scores */
  rewards: RewardScore[];
  /** Total number of criteria evaluated */
  totalCriteria: number;
  /** Number of criteria that errored */
  errors: number;
}

/**
 * Configuration for an LLM judge criterion.
 */
export interface JudgeConfig {
  /** The language model to use as judge */
  model: LanguageModel;
  /** Files to include in the judge prompt (glob patterns or paths) */
  files: string[];
  /** The evaluation question/rubric */
  prompt: string;
  /**
   * Type of judgment:
   * - "binary": yes/no → 1.0/0.0
   * - "likert": 1-N scale → normalized to 0.0-1.0
   * - "float": direct 0.0-1.0 score
   */
  type: "binary" | "likert" | "float";
  /** Number of points for likert scale (default: 5) */
  points?: number;
}

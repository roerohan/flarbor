import type { LanguageModel } from "ai";
import type { CriterionContext } from "flarbor-shared";

export type {
  TokenUsage,
  CriterionContext,
  CriterionResult,
  AggregationStrategy,
  RewardScore,
  RewardResult,
  WorkspaceLike,
} from "flarbor-shared";

export interface Criterion {
  name: string;
  description?: string;
  weight: number;
  evaluate: (ctx: CriterionContext) => Promise<number | boolean>;
}

export interface Reward {
  name: string;
  description?: string;
  criteria: Criterion[];
  aggregation?: import("flarbor-shared").AggregationStrategy;
}

export interface JudgeConfig {
  model: LanguageModel;
  files: string[];
  prompt: string;
  type: "binary" | "likert" | "float";
  points?: number;
}

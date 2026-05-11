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
  usage?: import("flarbor-shared").TokenUsage;
  reward?: import("flarbor-shared").RewardResult;
  metadata?: Record<string, unknown>;
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
  LOADER?: WorkerLoader;
  WORKSPACE_BUCKET?: R2Bucket;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
}

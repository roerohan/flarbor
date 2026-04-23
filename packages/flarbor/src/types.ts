import type { LanguageModel, ToolSet } from "ai";
import type { Session } from "agents/experimental/memory/session";

/**
 * Configuration for a single task to be executed by an agent.
 * Equivalent to Harbor's task definition.
 */
export interface TaskConfig {
  /** URL of the repository to clone */
  repoUrl: string;
  /** Instructions for the agent (what changes to make) */
  instructions: string;
  /** Branch name to create for the changes (auto-generated if omitted) */
  branch?: string;
  /** Git author name */
  authorName?: string;
  /** Git author email */
  authorEmail?: string;
  /** Maximum number of agentic loop steps before stopping */
  maxSteps?: number;
}

/**
 * Result of a completed trial (one agent attempt at a task).
 * Equivalent to Harbor's trial result.
 */
export interface TrialResult {
  /** Whether the task completed successfully */
  success: boolean;
  /** Branch name where changes were pushed */
  branch: string;
  /** Commit SHA of the final commit */
  commitSha: string;
  /** List of files that were changed */
  filesChanged: string[];
  /** Error message if the task failed */
  error?: string;
  /** Token usage across the entire task */
  usage?: TokenUsage;
  /** Reward/scoring result from evaluating the trial output */
  reward?: Record<string, unknown>;
}

/**
 * Token usage tracking for a task run.
 * Field names match the AI SDK's LanguageModelUsage.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Git author/committer identity.
 */
export interface GitConfig {
  authorName: string;
  authorEmail: string;
}

/**
 * Configuration that environment subclasses provide to FlarborEnvironment.
 *
 * The library handles infrastructure (lifecycle hooks, git, task execution).
 * The environment provides everything domain-specific: model, prompt, tools,
 * session configuration, and safety rules.
 */
export interface EnvironmentConfig {
  /** The language model to use for inference */
  model: LanguageModel;

  /**
   * System prompt for the agent. Required — there is no default.
   * The library does not know what kind of agent this is.
   */
  systemPrompt: string;

  /**
   * Configure the Think session (context blocks, compaction, search, skills).
   * Called once during onStart with the base session. Return the configured
   * session. If omitted, the session is used as-is (no context blocks).
   *
   * @example
   * ```typescript
   * configureSession: (session) => session
   *   .withContext("plan", { description: "Current plan", maxTokens: 1000 })
   *   .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
   *   .withCachedPrompt(),
   * ```
   */
  configureSession?: (session: Session) => Session | Promise<Session>;

  /** Additional tools beyond the built-in workspace + execute tools */
  tools?: ToolSet;

  /** Maximum agentic loop steps per turn (default: 25) */
  maxSteps?: number;

  /** File paths to block from writes (glob patterns) */
  protectedPaths?: string[];

  /** Whether to enable code execution via Dynamic Workers (default: true if LOADER is bound) */
  enableCodeExecution?: boolean;
}

/**
 * Env bindings expected by Flarbor environments.
 * Each environment's wrangler.jsonc should provide these.
 */
export interface FlarborEnv {
  AI: Ai;
  LOADER: WorkerLoader;
  GITHUB_TOKEN?: string;
}

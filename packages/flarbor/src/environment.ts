import { Think, type Session, Workspace } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import type { ToolSet } from "ai";
import type {
  ToolCallContext,
  ToolCallDecision,
  ToolCallResultContext,
  StepContext,
  ChatResponseResult,
} from "@cloudflare/think";

import { GitWorkspace } from "./workspace.js";
import type {
  TokenUsage,
  EnvironmentConfig,
  FlarborEnv,
} from "./types.js";

/**
 * Matches a filepath against a list of glob-like patterns.
 * Supports simple wildcards: `*` matches anything except `/`,
 * `**` matches everything including `/`.
 */
function matchesProtectedPath(
  filepath: string,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/\*\*/g, "§§")
          .replace(/\*/g, "[^/]*")
          .replace(/§§/g, ".*") +
        "$",
    );
    if (regex.test(filepath)) return true;
  }
  return false;
}

/**
 * FlarborEnvironment is the abstract base class for all Flarbor environments.
 *
 * It provides the infrastructure layer on top of Think:
 * - Model, prompt, tools, and session wiring (delegated to `getEnvironmentConfig()`)
 * - Code execution tool wiring (via Dynamic Workers, if enabled)
 * - Lifecycle hooks (tool call safety, failure logging, token tracking, error capture)
 * - Chat recovery for durable execution
 * - Git workspace accessor
 *
 * It does NOT define any specific workflow. The task execution flow
 * (what happens when a task is received) is the environment's responsibility.
 * Subclasses implement `getEnvironmentConfig()` for configuration and
 * override `fetch()` to define their own HTTP routing and task workflows.
 *
 * **Agent framework workaround**: The Agent/PartyServer framework has a
 * known race condition where `this.name` is not available during `onStart()`
 * when using `getByName()` (https://github.com/cloudflare/workerd/issues/2240).
 * FlarborEnvironment works around this by:
 * 1. Pre-creating the Workspace with `ctx.id` instead of `this.name`
 * 2. Suppressing the `.name` error in `onError` during startup
 * 3. Re-triggering initialization via `super.fetch()` which hydrates the
 *    name from the `x-partykit-room` header before processing
 *
 * Callers MUST pass the `x-partykit-room` header when calling the DO's
 * fetch endpoint. The `runTask()` helper does this automatically.
 */
export abstract class FlarborEnvironment<
  Env extends FlarborEnv = FlarborEnv,
> extends Think<Env> {
  /**
   * Subclasses must implement this to provide the model and configuration.
   */
  abstract getEnvironmentConfig(): EnvironmentConfig;

  /**
   * Override workspace to avoid the this.name hydration race condition.
   * Think's onStart() checks `if (!this.workspace)` before creating one,
   * so setting it here (via class field initializer, which runs during
   * construction) prevents Think from creating its own with `this.name`.
   *
   * Uses ctx.id.toString() which is always available, unlike this.name
   * which requires setName() RPC from the Agent framework.
   * See: https://github.com/cloudflare/workerd/issues/2240
   */
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.toString(),
  });

  // --- Internal state ---

  private _gitWorkspace: GitWorkspace | null = null;
  private _config: EnvironmentConfig | null = null;
  private _tokenUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  private _turnError: string | null = null;
  private _turnCompleted = false;

  /** Lazily resolved environment config. */
  protected get envConfig(): EnvironmentConfig {
    if (!this._config) {
      this._config = this.getEnvironmentConfig();
    }
    return this._config;
  }

  /** GitWorkspace wrapping this.workspace + git handle. */
  get gitWorkspace(): GitWorkspace {
    if (!this._gitWorkspace) {
      this._gitWorkspace = new GitWorkspace(this.workspace);
    }
    return this._gitWorkspace;
  }

  // --- Token / error tracking (accessible to subclasses) ---

  /** Current accumulated token usage. Reset via `resetTaskState()`. */
  protected get tokenUsage(): TokenUsage {
    return { ...this._tokenUsage };
  }

  /** Error captured during the last inference turn, or null. */
  protected get turnError(): string | null {
    return this._turnError;
  }

  /** Whether the last inference turn completed (success or error). */
  protected get turnCompleted(): boolean {
    return this._turnCompleted;
  }

  /**
   * Reset per-task tracking state. Call this at the start of each
   * task execution to clear token counts and error state.
   */
  protected resetTaskState(): void {
    this._tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this._turnError = null;
    this._turnCompleted = false;
  }

  // --- Think overrides ---

  override chatRecovery = true;
  override maxSteps = 25;

  /**
   * Suppress the known Agent framework .name race condition error during
   * onStart(). The error is non-fatal — initialization will be retried
   * when fetch() calls super.fetch() (which triggers PartyServer's
   * ensureInitialized with the name from the x-partykit-room header).
   */
  override onError(...args: unknown[]): void {
    const error = args.length === 2 ? args[1] : args[0];
    const message =
      error instanceof Error ? error.message : String(error);
    if (message.includes("Attempting to read .name")) {
      console.warn(
        "[flarbor] Suppressed .name race condition error during startup. " +
        "Will re-initialize on first fetch.",
      );
      return;
    }
    // For all other errors, re-throw
    throw error;
  }

  getModel() {
    return this.envConfig.model;
  }

  getSystemPrompt() {
    return this.envConfig.systemPrompt;
  }

  override getTools(): ToolSet {
    const tools: ToolSet = { ...this.envConfig.tools };

    // Add code execution tool if LOADER is available and not disabled
    if (this.envConfig.enableCodeExecution !== false && this.env.LOADER) {
      tools.execute = createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        loader: this.env.LOADER,
      });
    }

    return tools;
  }

  override configureSession(session: Session) {
    const configure = this.envConfig.configureSession;
    if (configure) {
      return configure(session);
    }
    return session;
  }

  // --- Lifecycle hooks ---

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const protectedPaths = this.envConfig.protectedPaths;

    // Block writes/edits/deletes to protected paths
    if (protectedPaths && protectedPaths.length > 0) {
      const input = ctx.input as Record<string, unknown>;
      const toolName = ctx.toolName as string;
      const path = (input.path ?? input.filepath) as string | undefined;

      if (
        path &&
        ["write", "edit", "delete"].includes(toolName) &&
        matchesProtectedPath(path, protectedPaths)
      ) {
        return {
          action: "block",
          reason: `Path "${path}" is protected and cannot be modified.`,
        };
      }
    }
  }

  override afterToolCall(ctx: ToolCallResultContext): void {
    const toolName = ctx.toolName as string;
    const durationMs = ctx.durationMs;

    if (!ctx.success) {
      console.error(
        `[flarbor] Tool "${toolName}" failed after ${durationMs}ms:`,
        ctx.error,
      );
    }
  }

  override onStepFinish(ctx: StepContext): void {
    // Accumulate token usage across all steps
    const usage = ctx.usage;
    if (usage) {
      this._tokenUsage.inputTokens += usage.inputTokens ?? 0;
      this._tokenUsage.outputTokens += usage.outputTokens ?? 0;
      this._tokenUsage.totalTokens += usage.totalTokens ?? 0;
    }
  }

  override onChatResponse(result: ChatResponseResult): void {
    if (result.status === "error") {
      this._turnError = result.error ?? "Unknown error during inference";
    } else if (result.status === "aborted") {
      this._turnError = "Turn was aborted";
    }
    this._turnCompleted = true;
  }

  override onChatError(error: unknown): unknown {
    const message =
      error instanceof Error ? error.message : String(error);
    this._turnError = message;
    console.error("[flarbor] Chat error:", message);
    return error;
  }
}

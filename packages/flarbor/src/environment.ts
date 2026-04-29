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

import { matchesGlob } from "./glob.js";
import { GitWorkspace } from "./workspace.js";
import type { TokenUsage, EnvironmentConfig, FlarborEnv } from "./types.js";

/**
 * Abstract base class for all Flarbor environments.
 *
 * Provides the infrastructure layer on top of Think: model/prompt/tools wiring,
 * code execution via Dynamic Workers, lifecycle hooks (tool safety, token tracking,
 * error capture), chat recovery, and git workspace access.
 *
 * Does NOT define any task workflow — subclasses own that via `onRequest()`.
 *
 * **Workaround**: Pre-creates Workspace with `ctx.id` instead of `this.name` to
 * avoid the Agent framework's known `.name` hydration race condition during `onStart()`.
 */
export abstract class FlarborEnvironment<
  Env extends FlarborEnv = FlarborEnv,
> extends Think<Env> {
  abstract getEnvironmentConfig(): EnvironmentConfig;

  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.ctx.id.toString(),
  });

  private _gitWorkspace: GitWorkspace | null = null;
  private _config: EnvironmentConfig | null = null;
  private _tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private _turnError: string | null = null;
  private _turnCompleted = false;

  protected get envConfig(): EnvironmentConfig {
    this._config ??= this.getEnvironmentConfig();
    return this._config;
  }

  get gitWorkspace(): GitWorkspace {
    this._gitWorkspace ??= new GitWorkspace(this.workspace);
    return this._gitWorkspace;
  }

  protected get tokenUsage(): TokenUsage {
    return { ...this._tokenUsage };
  }

  protected get turnError(): string | null {
    return this._turnError;
  }

  protected get turnCompleted(): boolean {
    return this._turnCompleted;
  }

  protected resetTaskState(): void {
    this._tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this._turnError = null;
    this._turnCompleted = false;
  }

  override chatRecovery = true;
  override maxSteps = 25;

  /** Suppress the known Agent framework `.name` race condition error during startup. */
  override onError(...args: unknown[]): void {
    const error = args.length === 2 ? args[1] : args[0];
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Attempting to read .name")) {
      console.warn("[flarbor] Suppressed .name race condition error during startup.");
      return;
    }
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
    return configure ? configure(session) : session;
  }

  override beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
    const protectedPaths = this.envConfig.protectedPaths;
    if (!protectedPaths || protectedPaths.length === 0) return;

    const input = ctx.input;
    if (input === null || typeof input !== "object") return;

    const record = input as Record<string, unknown>;
    const path =
      typeof record.path === "string"
        ? record.path
        : typeof record.filepath === "string"
          ? record.filepath
          : undefined;

    if (
      path &&
      ["write", "edit", "delete"].includes(ctx.toolName) &&
      matchesGlob(path, protectedPaths)
    ) {
      return {
        action: "block",
        reason: `Path "${path}" is protected and cannot be modified.`,
      };
    }
  }

  override afterToolCall(ctx: ToolCallResultContext): void {
    if (!ctx.success) {
      console.error(
        `[flarbor] Tool "${ctx.toolName}" failed after ${ctx.durationMs}ms:`,
        ctx.error,
      );
    }
  }

  override onStepFinish(ctx: StepContext): void {
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
    const message = error instanceof Error ? error.message : String(error);
    this._turnError = message;
    console.error("[flarbor] Chat error:", message);
    return error;
  }
}

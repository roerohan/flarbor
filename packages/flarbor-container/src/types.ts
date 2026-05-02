import type { Sandbox } from "@cloudflare/sandbox";
import type { WorkspaceLike as BaseWorkspaceLike } from "flarbor-shared";

export type SandboxNamespace = DurableObjectNamespace<Sandbox>;

export type CommandPattern = string | RegExp | ((command: string) => boolean);

export interface WorkspaceEntry {
  path: string;
  type: string;
}

/**
 * Extended workspace interface for container operations.
 *
 * Extends the base `WorkspaceLike` from flarbor-shared with binary file
 * support and typed `WorkspaceEntry` returns for `readDir`/`glob`.
 */
export interface WorkspaceLike extends BaseWorkspaceLike {
  readFileBytes?(path: string): Promise<Uint8Array | null>;
  readDir(dir?: string, opts?: { limit?: number; offset?: number }): Promise<WorkspaceEntry[]>;
  glob?(pattern: string): Promise<WorkspaceEntry[]>;
}

export interface ContainerRunContext {
  command: string;
  cwd: string;
}

export interface ContainerRunnerConfig {
  sandbox: SandboxNamespace;
  workspace: WorkspaceLike;
  sandboxId: string | ((context: ContainerRunContext) => string);
  root?: string;
  allowedCommands?: readonly CommandPattern[];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  keepAlive?: boolean;
  sleepAfter?: string;
  retry?: RetryConfig;
  defaultInclude?: readonly string[];
  defaultExclude?: readonly string[];
}

export interface RetryConfig {
  attempts?: number;
  delayMs?: number;
}

export interface ContainerCommandRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  include?: readonly string[];
  exclude?: readonly string[];
  captureFiles?: readonly string[];
}

export interface CapturedFile {
  path: string;
  content: string;
}

export interface ContainerCommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  files?: readonly CapturedFile[];
}

export interface WorkspaceSyncOptions {
  include?: readonly string[];
  exclude?: readonly string[];
  targetDir?: string;
}

export interface WorkspaceSyncResult {
  filesWritten: number;
  filesSkipped: number;
  bytesWritten: number;
}

export class ContainerCommandError extends Error {
  readonly code: "COMMAND_NOT_ALLOWED" | "INVALID_COMMAND" | "INVALID_PATH" | "SANDBOX_ERROR";

  constructor(code: ContainerCommandError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContainerCommandError";
    this.code = code;
  }
}

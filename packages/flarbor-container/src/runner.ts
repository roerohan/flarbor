import { getSandbox, type ExecOptions, type ExecResult, type Sandbox } from "@cloudflare/sandbox";

import { clampTimeout, DEFAULT_ALLOWED_COMMANDS, validateCommand } from "./commands.js";
import {
  joinSandboxPath,
  normalizeRelativeDirectory,
  normalizeRelativePath,
  normalizeSandboxRoot,
} from "./paths.js";
import { truncateText } from "./output.js";
import { syncWorkspaceToSandbox } from "./workspace-sync.js";
import {
  ContainerCommandError,
  type CapturedFile,
  type ContainerCommandRequest,
  type ContainerCommandResult,
  type ContainerRunnerConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 60_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_SANDBOX_ROOT = "/workspace/repo";

export class ContainerRunner {
  private readonly config: ContainerRunnerConfig;

  constructor(config: ContainerRunnerConfig) {
    this.config = config;
  }

  async run(request: ContainerCommandRequest): Promise<ContainerCommandResult> {
    const command = request.command;
    validateCommand(command, this.config.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);

    const cwd = normalizeRelativeDirectory(request.cwd);
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      this.config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    );
    const context = { command, cwd };
    const sandboxId =
      typeof this.config.sandboxId === "function"
        ? this.config.sandboxId(context)
        : this.config.sandboxId;
    const sandbox = getSandbox(this.config.sandbox, sandboxId, {
      keepAlive: this.config.keepAlive,
      sleepAfter: this.config.sleepAfter,
    });
    const sandboxRoot = normalizeSandboxRoot(this.config.root ?? DEFAULT_SANDBOX_ROOT);

    await prepareSandboxRoot(sandbox, sandboxRoot);
    await syncWorkspaceToSandbox(this.config.workspace, sandbox, {
      targetDir: sandboxRoot,
      include: request.include ?? this.config.defaultInclude,
      exclude: request.exclude ?? this.config.defaultExclude,
    });

    const startedAt = Date.now();
    try {
      const execResult = await this.execWithRetry(sandbox, command, {
        cwd: joinSandboxPath(sandboxRoot, cwd),
        env: request.env,
        timeout: timeoutMs,
      });
      const durationMs =
        typeof execResult.duration === "number" ? execResult.duration : Date.now() - startedAt;
      const stdout = truncateText(
        execResult.stdout ?? "",
        this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      );
      const stderr = truncateText(
        execResult.stderr ?? "",
        this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      );
      const files = request.captureFiles
        ? await this.captureFiles(sandbox, sandboxRoot, request.captureFiles)
        : undefined;
      const timedOut = execResult.exitCode === 124;

      return {
        success: timedOut ? false : execResult.success,
        exitCode: execResult.exitCode ?? (execResult.success ? 0 : 1),
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs,
        timedOut,
        outputTruncated: stdout.truncated || stderr.truncated,
        ...(files ? { files } : {}),
      };
    } catch (error) {
      if (isTimeoutError(error)) {
        await cleanupTimedOutSandbox(sandbox);
        return {
          success: false,
          exitCode: 124,
          stdout: "",
          stderr: `Container command timed out after ${timeoutMs}ms. The sandbox process was cleaned up when possible.`,
          durationMs: Date.now() - startedAt,
          timedOut: true,
          outputTruncated: false,
        };
      }

      throw new ContainerCommandError(
        "SANDBOX_ERROR",
        `Container command failed before producing a result: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async execWithRetry(
    sandbox: Sandbox,
    command: string,
    options: ExecOptions,
  ): Promise<ExecResult> {
    const attempts = this.config.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
    const delayMs = this.config.retry?.delayMs ?? DEFAULT_RETRY_DELAY_MS;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await sandbox.exec(command, options);
      } catch (error) {
        if (getErrorCode(error) !== "CONTAINER_NOT_READY" || attempt === attempts) throw error;
        await delay(delayMs);
      }
    }

    throw new ContainerCommandError(
      "SANDBOX_ERROR",
      "Container command retry loop exited without a result. This should not happen.",
    );
  }

  private async captureFiles(
    sandbox: Sandbox,
    sandboxRoot: string,
    paths: readonly string[],
  ): Promise<readonly CapturedFile[]> {
    const files: CapturedFile[] = [];
    for (const path of paths) {
      const normalized = normalizeRelativePath(path);
      const file = await sandbox.readFile(joinSandboxPath(sandboxRoot, normalized));
      files.push({
        path: normalized,
        content: readFileContent(file),
      });
    }
    return files;
  }
}

async function prepareSandboxRoot(sandbox: Sandbox, sandboxRoot: string): Promise<void> {
  await sandbox.exec(`rm -rf ${sandboxRoot} && mkdir -p ${sandboxRoot}`, {
    timeout: 30_000,
    origin: "internal",
  });
}

async function cleanupTimedOutSandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.destroy();
  } catch (error) {
    console.warn(
      `[flarbor-container] failed to destroy timed-out sandbox: ${getErrorMessage(error)}`,
    );
  }
}

function readFileContent(file: ReadFileResult): string {
  return file.content;
}

type ReadFileResult = Awaited<ReturnType<Sandbox["readFile"]>>;

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isTimeoutError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === "TIMEOUT" || code === "PROCESS_READY_TIMEOUT") return true;
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

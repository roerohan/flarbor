import type { ExecOptions, ExecResult, Sandbox } from "@cloudflare/sandbox";

import {
  joinSandboxPath,
  normalizeRelativeDirectory,
  normalizeSandboxRoot,
  shellQuote,
} from "./path.js";
import { truncateText } from "./output.js";
import type { CapturedArtifact, SandboxExecConfig, VerifyExec } from "./types.js";

const DEFAULT_ROOT = "/workspace/repo";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 60_000;

export function createSandboxExec(config: SandboxExecConfig): VerifyExec {
  const root = normalizeSandboxRoot(config.root ?? DEFAULT_ROOT);
  let sandboxPromise: Promise<Sandbox> | undefined;
  let preparePromise: Promise<void> | undefined;

  return {
    async run(request) {
      const sandbox = await getOrCreateSandbox();
      await prepareOnce(sandbox, request.include, request.exclude);
      const startedAt = Date.now();
      const timeout = clampTimeout(
        request.timeoutMs,
        config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      );

      const result = await execCommand(sandbox, request.command, {
        cwd: joinSandboxPath(root, normalizeRelativeDirectory(request.cwd)),
        env: request.env,
        timeout,
      });
      const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdout = truncateText(result.stdout ?? "", maxOutputBytes);
      const stderr = truncateText(result.stderr ?? "", maxOutputBytes);
      const exitCode = result.exitCode ?? (result.success ? 0 : 1);
      const files = request.captureFiles
        ? await captureFiles(sandbox, root, request.captureFiles, maxOutputBytes)
        : undefined;

      return {
        success: exitCode === 124 ? false : result.success,
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: typeof result.duration === "number" ? result.duration : Date.now() - startedAt,
        timedOut: exitCode === 124,
        outputTruncated: stdout.truncated || stderr.truncated,
        ...(files ? { files } : {}),
      };
    },
  };

  async function getOrCreateSandbox(): Promise<Sandbox> {
    sandboxPromise ??= (async () => {
      const { getSandbox } = await import("@cloudflare/sandbox");
      return getSandbox(config.sandbox, config.sandboxId, {
        normalizeId: true,
        keepAlive: config.keepAlive,
        sleepAfter: config.sleepAfter,
      });
    })();
    return sandboxPromise;
  }

  async function prepareOnce(
    sandbox: Sandbox,
    include?: readonly string[],
    exclude?: readonly string[],
  ): Promise<void> {
    preparePromise ??= (async () => {
      await sandbox.exec(`rm -rf ${shellQuote(root)} && mkdir -p ${shellQuote(root)}`, {
        timeout: 30_000,
        origin: "internal",
      });
      const { syncWorkspaceToSandbox } = await import("flarbor-container");
      await syncWorkspaceToSandbox(config.workspace, sandbox, {
        targetDir: root,
        include: include ?? config.include,
        exclude: exclude ?? config.exclude,
      });
    })();
    await preparePromise;
  }
}

async function execCommand(
  sandbox: Sandbox,
  command: string,
  options: ExecOptions,
): Promise<ExecResult> {
  try {
    return await sandbox.exec(command, options);
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        success: false,
        exitCode: 124,
        stdout: "",
        stderr: `Container command timed out after ${options.timeout ?? DEFAULT_TIMEOUT_MS}ms.`,
        command,
        duration: options.timeout ?? DEFAULT_TIMEOUT_MS,
        timestamp: new Date().toISOString(),
      };
    }
    throw error;
  }
}

async function captureFiles(
  sandbox: Sandbox,
  root: string,
  paths: readonly string[],
  maxBytes: number,
): Promise<readonly CapturedArtifact[]> {
  const files: CapturedArtifact[] = [];
  for (const path of paths) {
    try {
      const content = await sandbox.readFile(joinSandboxPath(root, path));
      const truncated = truncateText(content.content, maxBytes);
      files.push({ path, content: truncated.text, truncated: truncated.truncated });
    } catch {
      // File not found or unreadable — skip silently.
      // Callers inspect the returned list to determine what was captured.
    }
  }
  return files;
}

function clampTimeout(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined) return defaultValue;
  return Math.min(Math.max(1, value), maxValue);
}

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isTimeoutError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === "TIMEOUT" || code === "PROCESS_READY_TIMEOUT") return true;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

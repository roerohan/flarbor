import type { ExecResult, Sandbox } from "@cloudflare/sandbox";

import { createVerifyError, errorFromUnknown, VerifyFailure } from "./errors.js";
import {
  joinSandboxPath,
  normalizeRelativePath,
  normalizeSandboxRoot,
  shellQuote,
} from "./path.js";
import { truncateText } from "./output.js";
import { parseRewardJson, parseRewardText } from "./rewards.js";
import type {
  ArtifactSpec,
  CapturedArtifact,
  TestSource,
  VerifierLogs,
  VerifyError,
  VerifyResult,
  VerifyScriptConfig,
} from "./types.js";

const DEFAULT_WORKSPACE_ROOT = "/workspace/repo";
const DEFAULT_TESTS_DIR = "/workspace/tests";
const DEFAULT_LOGS_DIR = "/workspace/logs";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 60_000;
const HARBOR_LOGS_DIR = "/logs";

interface ScriptCommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export async function verifyScript(config: VerifyScriptConfig): Promise<VerifyResult> {
  const startedAt = Date.now();
  const workspaceRoot = normalizeSandboxRoot(config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
  const testsDir = normalizeSandboxRoot(config.testsDir ?? DEFAULT_TESTS_DIR);
  const logsDir = normalizeSandboxRoot(config.logsDir ?? DEFAULT_LOGS_DIR);
  const verifierDir = `${logsDir}/verifier`;
  const artifactsDir = `${logsDir}/artifacts`;
  const harborVerifierDir = `${HARBOR_LOGS_DIR}/verifier`;
  const harborArtifactsDir = `${HARBOR_LOGS_DIR}/artifacts`;
  const os = config.os ?? "linux";
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(config.sandbox, config.sandboxId);

  let command: ScriptCommandResult | undefined;

  try {
    if (os === "windows") {
      return errorResult(
        "script",
        createVerifyError(
          "UNSUPPORTED_OS",
          "Windows verifier scripts are modeled but not supported by the current Cloudflare Sandbox runtime.",
        ),
        Date.now() - startedAt,
      );
    }

    await prepareSandbox(sandbox, workspaceRoot, testsDir, logsDir);
    await syncWorkspace(config.workspace, sandbox, {
      targetDir: workspaceRoot,
      include: config.include,
      exclude: config.exclude,
    });
    await uploadTests(config.tests, sandbox, testsDir);

    const scriptName = normalizeRelativePath(config.scriptName ?? "test.sh");
    const scriptPath = joinSandboxPath(testsDir, scriptName);
    if (!(await exists(sandbox, scriptPath))) {
      return errorResult(
        "script",
        createVerifyError(
          "TEST_SCRIPT_NOT_FOUND",
          `No verifier script found at ${scriptPath}. Expected ${scriptName}.`,
        ),
        Date.now() - startedAt,
        undefined,
        await captureLogs(sandbox, verifierDir, maxOutputBytes),
      );
    }

    await sandbox.exec(`chmod +x ${shellQuote(scriptPath)}`, {
      timeout: 30_000,
      origin: "internal",
    });
    const stdoutPath = `${verifierDir}/test-stdout.txt`;
    const execResult = await sandbox.exec(
      `(${shellQuote(scriptPath)}) > ${shellQuote(stdoutPath)} 2>&1`,
      {
        cwd: workspaceRoot,
        env: config.env,
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    );
    command = commandResult(execResult, maxOutputBytes);

    const logs = await captureLogs(sandbox, verifierDir, maxOutputBytes, command);
    const rewardText = await readFirstText(sandbox, [
      `${verifierDir}/reward.txt`,
      `${harborVerifierDir}/reward.txt`,
    ]);
    const rewardJson = await readFirstText(sandbox, [
      `${verifierDir}/reward.json`,
      `${harborVerifierDir}/reward.json`,
    ]);
    const details = await readFirstJsonIfPresent(sandbox, [
      `${verifierDir}/reward-details.json`,
      `${harborVerifierDir}/reward-details.json`,
    ]);
    const artifacts = await captureArtifacts(
      sandbox,
      [artifactsDir, harborArtifactsDir],
      config.artifacts ?? [],
      maxOutputBytes,
    );

    if (rewardText !== null) {
      return {
        kind: "verified",
        rewards: parseRewardText(rewardText),
        ...(details === undefined ? {} : { details }),
        logs,
        artifacts,
        durationMs: Date.now() - startedAt,
        mode: "script",
      };
    }
    if (rewardJson !== null) {
      return {
        kind: "verified",
        rewards: parseRewardJson(rewardJson),
        ...(details === undefined ? {} : { details }),
        logs,
        artifacts,
        durationMs: Date.now() - startedAt,
        mode: "script",
      };
    }

    return errorResult(
      "script",
      createVerifyError(
        "REWARD_FILE_NOT_FOUND",
        `No reward file found at ${verifierDir}/reward.txt, ${verifierDir}/reward.json, ${harborVerifierDir}/reward.txt, or ${harborVerifierDir}/reward.json.`,
      ),
      Date.now() - startedAt,
      artifacts,
      logs,
    );
  } catch (error) {
    const logs = await captureLogs(sandbox, verifierDir, maxOutputBytes, command).catch(
      () => undefined,
    );
    const verifyError =
      error instanceof VerifyFailure
        ? error.error
        : errorFromUnknown(error, "SANDBOX_ERROR", "Verifier script failed before completion.");
    return errorResult("script", verifyError, Date.now() - startedAt, [], logs);
  }
}

async function prepareSandbox(
  sandbox: Sandbox,
  workspaceRoot: string,
  testsDir: string,
  logsDir: string,
): Promise<void> {
  await sandbox.exec(
    `rm -rf ${shellQuote(workspaceRoot)} ${shellQuote(testsDir)} ${shellQuote(logsDir)} ${shellQuote(HARBOR_LOGS_DIR)} && mkdir -p ${shellQuote(workspaceRoot)} ${shellQuote(testsDir)} ${shellQuote(logsDir)}/verifier ${shellQuote(logsDir)}/agent ${shellQuote(logsDir)}/artifacts ${shellQuote(HARBOR_LOGS_DIR)}/verifier ${shellQuote(HARBOR_LOGS_DIR)}/agent ${shellQuote(HARBOR_LOGS_DIR)}/artifacts`,
    { timeout: 30_000, origin: "internal" },
  );
}

async function uploadTests(source: TestSource, sandbox: Sandbox, testsDir: string): Promise<void> {
  try {
    if (source.kind === "skip-upload") return;
    if (source.kind === "workspace") {
      await syncWorkspace(source.workspace, sandbox, {
        targetDir: testsDir,
        include: source.include,
        exclude: source.exclude,
      });
      return;
    }

    for (const file of source.files) {
      const path = joinSandboxPath(testsDir, file.path);
      if (typeof file.content === "string") {
        await sandbox.writeFile(path, file.content);
      } else {
        await sandbox.writeFile(path, bytesToBase64(file.content), { encoding: "base64" });
      }
    }
  } catch (error) {
    if (error instanceof VerifyFailure) throw error;
    throw new VerifyFailure(
      createVerifyError("TEST_UPLOAD_FAILED", "Failed to upload verifier tests.", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function syncWorkspace(
  workspace: VerifyScriptConfig["workspace"],
  sandbox: Sandbox,
  options: { targetDir: string; include?: readonly string[]; exclude?: readonly string[] },
): Promise<void> {
  const { syncWorkspaceToSandbox } = await import("flarbor-container");
  await syncWorkspaceToSandbox(workspace, sandbox, options);
}

async function exists(sandbox: Sandbox, path: string): Promise<boolean> {
  return (await readText(sandbox, path)) !== null;
}

async function readText(sandbox: Sandbox, path: string): Promise<string | null> {
  try {
    const result = await sandbox.readFile(path);
    return result.content;
  } catch {
    return null;
  }
}

async function readJsonIfPresent(sandbox: Sandbox, path: string): Promise<unknown | undefined> {
  const text = await readText(sandbox, path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readFirstText(sandbox: Sandbox, paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    const content = await readText(sandbox, path);
    if (content !== null) return content;
  }
  return null;
}

async function readFirstJsonIfPresent(
  sandbox: Sandbox,
  paths: readonly string[],
): Promise<unknown | undefined> {
  for (const path of paths) {
    const parsed = await readJsonIfPresent(sandbox, path);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

async function captureLogs(
  sandbox: Sandbox,
  verifierDir: string,
  maxOutputBytes: number,
  command?: ScriptCommandResult,
): Promise<VerifierLogs> {
  const testStdoutRaw = await readText(sandbox, `${verifierDir}/test-stdout.txt`);
  const stdout = truncateText(command?.stdout ?? "", maxOutputBytes);
  const stderr = truncateText(command?.stderr ?? "", maxOutputBytes);
  const testStdout =
    testStdoutRaw === null ? undefined : truncateText(testStdoutRaw, maxOutputBytes);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    ...(testStdout ? { testStdout: testStdout.text } : {}),
    outputTruncated: stdout.truncated || stderr.truncated || (testStdout?.truncated ?? false),
  };
}

async function captureArtifacts(
  sandbox: Sandbox,
  artifactDirs: readonly string[],
  specs: readonly ArtifactSpec[],
  defaultMaxBytes: number,
): Promise<readonly CapturedArtifact[]> {
  const artifacts: CapturedArtifact[] = [];
  for (const spec of specs) {
    const path = normalizeRelativePath(spec.path);
    const content = await readFirstText(
      sandbox,
      artifactDirs.map((artifactDir) => joinSandboxPath(artifactDir, path)),
    );
    if (content === null) continue;
    const truncated = truncateText(content, spec.maxBytes ?? defaultMaxBytes);
    artifacts.push({ path, content: truncated.text, truncated: truncated.truncated });
  }
  return artifacts;
}

function commandResult(result: ExecResult, maxOutputBytes: number): ScriptCommandResult {
  const stdout = truncateText(result.stdout ?? "", maxOutputBytes);
  const stderr = truncateText(result.stderr ?? "", maxOutputBytes);
  const exitCode = result.exitCode ?? (result.success ? 0 : 1);
  return {
    success: result.success,
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs: typeof result.duration === "number" ? result.duration : 0,
    timedOut: exitCode === 124,
    outputTruncated: stdout.truncated || stderr.truncated,
  };
}

function errorResult(
  mode: "script",
  error: VerifyError,
  durationMs: number,
  artifacts: readonly CapturedArtifact[] = [],
  logs?: VerifierLogs,
): VerifyResult {
  return { kind: "error", error, artifacts, durationMs, mode, ...(logs ? { logs } : {}) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

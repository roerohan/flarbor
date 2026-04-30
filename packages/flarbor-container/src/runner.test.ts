import { getSandbox, type ExecResult, type Sandbox } from "@cloudflare/sandbox";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ContainerRunner } from "./runner.js";
import { syncWorkspaceToSandbox } from "./workspace-sync.js";
import { ContainerCommandError, type ContainerRunnerConfig, type WorkspaceLike } from "./types.js";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

vi.mock("./workspace-sync.js", () => ({
  syncWorkspaceToSandbox: vi.fn(),
}));

const workspace: WorkspaceLike = {
  async readFile() {
    return null;
  },
  async readDir() {
    return [];
  },
};

describe("ContainerRunner", () => {
  beforeEach(() => {
    vi.mocked(getSandbox).mockReset();
    vi.mocked(syncWorkspaceToSandbox).mockReset();
    vi.mocked(syncWorkspaceToSandbox).mockResolvedValue({
      filesWritten: 0,
      filesSkipped: 0,
      bytesWritten: 0,
    });
  });

  it("syncs the workspace, runs an allowlisted command, and captures files", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult({ command: "prepare" }))
      .mockResolvedValueOnce(
        execResult({ command: "npm test", stdout: "ok", stderr: "warn", duration: 42 }),
      );
    sandbox.readFile.mockResolvedValueOnce({
      success: true,
      path: "/workspace/repo/reports/result.txt",
      content: "captured",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    const runnerConfig = config({
      sandboxId: ({ command, cwd }) => `${command}:${cwd}`,
      allowedCommands: ["npm test"],
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 20_000,
    });
    const runner = new ContainerRunner(runnerConfig);

    await expect(
      runner.run({
        command: "npm test",
        cwd: "packages/app",
        env: { CI: "1" },
        timeoutMs: 15_000,
        include: ["src/**"],
        exclude: ["dist/**"],
        captureFiles: ["./reports/result.txt"],
      }),
    ).resolves.toEqual({
      success: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "warn",
      durationMs: 42,
      timedOut: false,
      outputTruncated: false,
      files: [{ path: "reports/result.txt", content: "captured" }],
    });
    expect(getSandbox).toHaveBeenCalledWith(runnerConfig.sandbox, "npm test:packages/app", {
      normalizeId: true,
      keepAlive: undefined,
      sleepAfter: undefined,
    });
    expect(syncWorkspaceToSandbox).toHaveBeenCalledWith(workspace, sandbox, {
      targetDir: "/workspace/repo",
      include: ["src/**"],
      exclude: ["dist/**"],
    });
    expect(sandbox.exec).toHaveBeenNthCalledWith(
      1,
      "rm -rf /workspace/repo && mkdir -p /workspace/repo",
      { timeout: 30_000, origin: "internal" },
    );
    expect(sandbox.exec).toHaveBeenNthCalledWith(2, "npm test", {
      cwd: "/workspace/repo/packages/app",
      env: { CI: "1" },
      timeout: 15_000,
    });
  });

  it("marks exit code 124 results as timed out", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult({ command: "prepare" }))
      .mockResolvedValueOnce(
        execResult({ command: "npm test", success: false, exitCode: 124, stderr: "timeout" }),
      );
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    await expect(new ContainerRunner(config()).run({ command: "npm test" })).resolves.toMatchObject(
      {
        success: false,
        exitCode: 124,
        stderr: "timeout",
        timedOut: true,
      },
    );
  });

  it("destroys the sandbox and returns a timeout result when exec throws a timeout", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult({ command: "prepare" }))
      .mockRejectedValueOnce(Object.assign(new Error("process timed out"), { code: "TIMEOUT" }));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    const result = await new ContainerRunner(config({ defaultTimeoutMs: 25 })).run({
      command: "npm test",
    });

    expect(result).toMatchObject({
      success: false,
      exitCode: 124,
      stdout: "",
      timedOut: true,
      outputTruncated: false,
    });
    expect(result.stderr).toContain("timed out after 25ms");
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
  });

  it("retries transient container readiness errors", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult({ command: "prepare" }))
      .mockRejectedValueOnce(Object.assign(new Error("not ready"), { code: "CONTAINER_NOT_READY" }))
      .mockResolvedValueOnce(execResult({ command: "npm test", stdout: "retried" }));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    await expect(
      new ContainerRunner(config({ retry: { attempts: 2, delayMs: 0 } })).run({
        command: "npm test",
      }),
    ).resolves.toMatchObject({ success: true, stdout: "retried" });
    expect(sandbox.exec).toHaveBeenCalledTimes(3);
  });

  it("wraps non-timeout sandbox execution errors", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult({ command: "prepare" }))
      .mockRejectedValueOnce(new Error("container exploded"));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    await expect(new ContainerRunner(config()).run({ command: "npm test" })).rejects.toMatchObject({
      name: "ContainerCommandError",
      code: "SANDBOX_ERROR",
      message: "Container command failed before producing a result: container exploded",
    });
  });

  it("rejects invalid commands before sandbox lookup", async () => {
    await expect(
      new ContainerRunner(config()).run({ command: "npm install" }),
    ).rejects.toMatchObject({
      code: "COMMAND_NOT_ALLOWED",
    });
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("truncates command output using the configured byte limit", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult({ command: "prepare" }))
      .mockResolvedValueOnce(execResult({ command: "npm test", stdout: "abcdef".repeat(20) }));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    await expect(
      new ContainerRunner(config({ maxOutputBytes: 60 })).run({ command: "npm test" }),
    ).resolves.toMatchObject({
      outputTruncated: true,
    });
  });
});

interface FakeSandbox {
  exec: Mock<Sandbox["exec"]>;
  readFile: Mock<Sandbox["readFile"]>;
  destroy: Mock<Sandbox["destroy"]>;
}

function makeSandbox(): FakeSandbox {
  return {
    exec: vi.fn<Sandbox["exec"]>(),
    readFile: vi.fn<Sandbox["readFile"]>(),
    destroy: vi.fn<Sandbox["destroy"]>(async () => {}),
  };
}

function asSandbox(sandbox: FakeSandbox): Sandbox {
  return sandbox as unknown as Sandbox;
}

function config(overrides: Partial<ContainerRunnerConfig> = {}): ContainerRunnerConfig {
  return {
    sandbox: makeDurableObjectNamespace(),
    workspace,
    sandboxId: "test-sandbox",
    allowedCommands: ["npm test"],
    ...overrides,
  };
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    command: "command",
    duration: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDurableObjectNamespace(): ContainerRunnerConfig["sandbox"] {
  const id = {
    toString() {
      return "durable-object-id";
    },
    equals() {
      return false;
    },
  };
  const namespace: ContainerRunnerConfig["sandbox"] = {
    newUniqueId() {
      return id;
    },
    idFromName() {
      return id;
    },
    idFromString() {
      return id;
    },
    get(): never {
      throw new ContainerCommandError("SANDBOX_ERROR", "Unexpected Durable Object get in test");
    },
    getByName(): never {
      throw new ContainerCommandError(
        "SANDBOX_ERROR",
        "Unexpected Durable Object getByName in test",
      );
    },
    jurisdiction() {
      return namespace;
    },
  };
  return namespace;
}

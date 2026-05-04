import { getSandbox, type ExecResult, type Sandbox } from "@cloudflare/sandbox";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { verifyScript } from "./script.js";
import type { SandboxNamespace, WorkspaceLike } from "./types.js";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

vi.mock("flarbor-container", () => ({
  syncWorkspaceToSandbox: vi.fn(async () => ({
    filesWritten: 0,
    filesSkipped: 0,
    bytesWritten: 0,
  })),
}));

const workspace: WorkspaceLike = {
  async readFile(path) {
    return path === "package.json" ? "{}" : null;
  },
  async readDir() {
    return [{ path: "package.json", type: "file" }];
  },
};

describe("verifyScript", () => {
  beforeEach(() => {
    vi.mocked(getSandbox).mockReset();
  });

  it("runs Harbor-compatible script mode and prefers reward.txt", async () => {
    const sandbox = makeSandbox();
    sandbox.readFile.mockImplementation(async (path) => {
      if (path === "/workspace/tests/test.sh") return readFileResult(path, "#!/bin/sh");
      if (path === "/workspace/logs/verifier/test-stdout.txt")
        return readFileResult(path, "test output");
      if (path === "/workspace/logs/verifier/reward.txt") return readFileResult(path, "0.8");
      if (path === "/workspace/logs/verifier/reward.json")
        return readFileResult(path, '{"reward":0.1}');
      throw new Error("not found");
    });
    sandbox.exec
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult({ stdout: "runner stdout" }));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    const result = await verifyScript({
      sandbox: makeNamespace(),
      sandboxId: "verify",
      workspace,
      tests: { kind: "files", files: [{ path: "test.sh", content: "#!/bin/sh" }] },
    });

    expect(result).toMatchObject({ kind: "verified", rewards: { reward: 0.8 }, mode: "script" });
    expect(sandbox.exec.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining("rm -rf"),
      expect.stringContaining("chmod +x"),
      expect.stringContaining("test.sh"),
    ]);
  });

  it("returns typed errors when reward output is missing", async () => {
    const sandbox = makeSandbox();
    sandbox.readFile.mockImplementation(async (path) => {
      if (path === "/workspace/tests/test.sh") return readFileResult(path, "#!/bin/sh");
      throw new Error("not found");
    });
    sandbox.exec
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult({ success: false, exitCode: 1 }));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    await expect(
      verifyScript({
        sandbox: makeNamespace(),
        sandboxId: "verify",
        workspace,
        tests: { kind: "files", files: [{ path: "test.sh", content: "#!/bin/sh" }] },
      }),
    ).resolves.toMatchObject({
      kind: "error",
      error: { code: "REWARD_FILE_NOT_FOUND" },
    });
  });

  it("reads Harbor default /logs verifier output", async () => {
    const sandbox = makeSandbox();
    sandbox.readFile.mockImplementation(async (path) => {
      if (path === "/workspace/tests/test.sh") return readFileResult(path, "#!/bin/sh");
      if (path === "/logs/verifier/reward.json") return readFileResult(path, '{"harbor":1}');
      throw new Error("not found");
    });
    sandbox.exec
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult());
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    await expect(
      verifyScript({
        sandbox: makeNamespace(),
        sandboxId: "verify",
        workspace,
        tests: { kind: "files", files: [{ path: "test.sh", content: "#!/bin/sh" }] },
      }),
    ).resolves.toMatchObject({ kind: "verified", rewards: { harbor: 1 } });
  });
});

interface FakeSandbox {
  exec: Mock<Sandbox["exec"]>;
  readFile: Mock<Sandbox["readFile"]>;
  writeFile: Mock<Sandbox["writeFile"]>;
}

function makeSandbox(): FakeSandbox {
  return {
    exec: vi.fn<Sandbox["exec"]>(),
    readFile: vi.fn<Sandbox["readFile"]>(),
    writeFile: vi.fn<Sandbox["writeFile"]>(async () => ({
      success: true,
      path: "",
      timestamp: "",
    })),
  };
}

function asSandbox(sandbox: FakeSandbox): Sandbox {
  return sandbox as unknown as Sandbox;
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

function readFileResult(path: string, content: string): Awaited<ReturnType<Sandbox["readFile"]>> {
  return { success: true, path, content, timestamp: "2026-01-01T00:00:00.000Z" };
}

function makeNamespace(): SandboxNamespace {
  const id = {
    toString() {
      return "id";
    },
    equals() {
      return false;
    },
  };
  return {
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
      throw new Error("unexpected get");
    },
    getByName(): never {
      throw new Error("unexpected getByName");
    },
    jurisdiction() {
      return makeNamespace();
    },
  };
}

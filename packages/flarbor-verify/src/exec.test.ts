import { getSandbox, type ExecResult, type Sandbox } from "@cloudflare/sandbox";
import { syncWorkspaceToSandbox } from "flarbor-container";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createSandboxExec } from "./exec.js";
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
  async readFile() {
    return null;
  },
  async readDir() {
    return [];
  },
};

describe("createSandboxExec", () => {
  beforeEach(() => {
    vi.mocked(getSandbox).mockReset();
    vi.mocked(syncWorkspaceToSandbox).mockClear();
  });

  it("prepares and syncs the sandbox once across multiple commands", async () => {
    const sandbox = makeSandbox();
    sandbox.exec
      .mockResolvedValueOnce(execResult())
      .mockResolvedValueOnce(execResult({ stdout: "installed" }))
      .mockResolvedValueOnce(execResult({ stdout: "tested" }));
    vi.mocked(getSandbox).mockReturnValue(asSandbox(sandbox));

    const exec = createSandboxExec({ sandbox: makeNamespace(), sandboxId: "verify", workspace });

    await expect(exec.run({ command: "pnpm install" })).resolves.toMatchObject({
      stdout: "installed",
    });
    await expect(exec.run({ command: "pnpm test" })).resolves.toMatchObject({ stdout: "tested" });

    expect(syncWorkspaceToSandbox).toHaveBeenCalledTimes(1);
    expect(sandbox.exec.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining("rm -rf"),
      "pnpm install",
      "pnpm test",
    ]);
  });
});

interface FakeSandbox {
  exec: Mock<Sandbox["exec"]>;
  readFile: Mock<Sandbox["readFile"]>;
}

function makeSandbox(): FakeSandbox {
  return { exec: vi.fn<Sandbox["exec"]>(), readFile: vi.fn<Sandbox["readFile"]>() };
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

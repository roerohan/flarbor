import { describe, expect, it } from "vitest";

import { listIncludedFiles, syncWorkspaceToSandbox } from "./workspace-sync.js";
import type { WorkspaceEntry, WorkspaceLike } from "./types.js";

describe("listIncludedFiles", () => {
  it("uses workspace glob results, filters include and exclude patterns, dedupes, and sorts", async () => {
    const workspace = new FakeWorkspace({
      globResults: new Map([
        [
          "**/*",
          [
            { path: "z.txt", type: "file" },
            { path: "node_modules/pkg/index.js", type: "file" },
            { path: "a.txt", type: "file" },
            { path: "a.txt", type: "file" },
            { path: "src", type: "directory" },
            { path: "src/index.ts", type: "file" },
          ],
        ],
      ]),
    });

    await expect(listIncludedFiles(workspace, ["**/*"], ["node_modules/**"])).resolves.toEqual([
      "a.txt",
      "src/index.ts",
      "z.txt",
    ]);
  });

  it("falls back to recursive directory listing when glob is unavailable", async () => {
    const dirs = new Map<string, readonly WorkspaceEntry[]>([
      [
        "",
        [
          { path: "src", type: "directory" },
          { path: "README.md", type: "file" },
        ],
      ],
      ["src", [{ path: "src/index.ts", type: "file" }]],
    ]);
    const workspace: WorkspaceLike = {
      async readFile() {
        return null;
      },
      async readDir(dir?: string) {
        return [...(dirs.get(dir ?? "") ?? [])];
      },
    };

    await expect(listIncludedFiles(workspace, ["**/*"], [])).resolves.toEqual([
      "README.md",
      "src/index.ts",
    ]);
  });
});

describe("syncWorkspaceToSandbox", () => {
  it("writes sorted text and binary files and reports byte counts", async () => {
    const workspace = new FakeWorkspace({
      globResults: new Map([
        [
          "**/*",
          [
            { path: "b.bin", type: "file" },
            { path: "a.txt", type: "file" },
          ],
        ],
      ]),
      textFiles: new Map([["a.txt", "hello 😊"]]),
      binaryFiles: new Map([["b.bin", new Uint8Array([0, 1, 2, 255])]]),
    });
    const sandbox = new FakeSandboxWriter();

    await expect(syncWorkspaceToSandbox(workspace, sandbox)).resolves.toEqual({
      filesWritten: 2,
      filesSkipped: 0,
      bytesWritten: new TextEncoder().encode("hello 😊").byteLength + 4,
    });
    expect(sandbox.writes).toEqual([
      { path: "/workspace/repo/a.txt", content: "hello 😊", options: undefined },
      { path: "/workspace/repo/b.bin", content: "AAEC/w==", options: { encoding: "base64" } },
    ]);
  });

  it("applies default and custom excludes and skips unreadable files", async () => {
    const workspace = new FakeWorkspace({
      globResults: new Map([
        [
          "**/*",
          [
            { path: ".git/config", type: "file" },
            { path: ".wrangler/state.json", type: "file" },
            { path: "node_modules/pkg/index.js", type: "file" },
            { path: "dist/out.js", type: "file" },
            { path: "src/index.ts", type: "file" },
            { path: "missing.txt", type: "file" },
          ],
        ],
      ]),
      textFiles: new Map([["src/index.ts", "source"]]),
    });
    const sandbox = new FakeSandboxWriter();

    await expect(
      syncWorkspaceToSandbox(workspace, sandbox, { exclude: ["dist/**"] }),
    ).resolves.toEqual({ filesWritten: 1, filesSkipped: 1, bytesWritten: 6 });
    expect(sandbox.writes).toEqual([
      { path: "/workspace/repo/src/index.ts", content: "source", options: undefined },
    ]);
  });

  it("uses a normalized custom target directory", async () => {
    const workspace = new FakeWorkspace({
      globResults: new Map([["src/**", [{ path: "src/index.ts", type: "file" }]]]),
      textFiles: new Map([["src/index.ts", "source"]]),
    });
    const sandbox = new FakeSandboxWriter();

    await syncWorkspaceToSandbox(workspace, sandbox, {
      include: ["src/**"],
      targetDir: "/workspace/custom/",
    });

    expect(sandbox.writes).toEqual([
      { path: "/workspace/custom/src/index.ts", content: "source", options: undefined },
    ]);
  });
});

class FakeWorkspace implements WorkspaceLike {
  private readonly dirs: ReadonlyMap<string, readonly WorkspaceEntry[]>;
  private readonly globResults: ReadonlyMap<string, readonly WorkspaceEntry[]>;
  private readonly textFiles: ReadonlyMap<string, string>;
  private readonly binaryFiles: ReadonlyMap<string, Uint8Array>;

  constructor(options: {
    dirs?: ReadonlyMap<string, readonly WorkspaceEntry[]>;
    globResults?: ReadonlyMap<string, readonly WorkspaceEntry[]>;
    textFiles?: ReadonlyMap<string, string>;
    binaryFiles?: ReadonlyMap<string, Uint8Array>;
  }) {
    this.dirs = options.dirs ?? new Map();
    this.globResults = options.globResults ?? new Map();
    this.textFiles = options.textFiles ?? new Map();
    this.binaryFiles = options.binaryFiles ?? new Map();
  }

  async readFile(path: string): Promise<string | null> {
    return this.textFiles.get(path) ?? null;
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.binaryFiles.get(path) ?? null;
  }

  async readDir(dir?: string): Promise<WorkspaceEntry[]> {
    return [...(this.dirs.get(dir ?? "") ?? [])];
  }

  async glob(pattern: string): Promise<WorkspaceEntry[]> {
    return [...(this.globResults.get(pattern) ?? [])];
  }
}

class FakeSandboxWriter {
  readonly writes: Array<{
    path: string;
    content: string;
    options: { encoding?: string } | undefined;
  }> = [];

  async writeFile(path: string, content: string, options?: { encoding?: string }): Promise<void> {
    this.writes.push({ path, content, options });
  }
}

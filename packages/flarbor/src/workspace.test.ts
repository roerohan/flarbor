import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Workspace } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";

import { GitWorkspace } from "./workspace.js";

const gitMocks = vi.hoisted(() => ({
  clone: vi.fn(),
  checkout: vi.fn(),
  branch: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@cloudflare/shell", () => {
  class MockWorkspace {
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
    }
  }

  class MockWorkspaceFileSystem {
    readonly workspace: unknown;

    constructor(workspace: unknown) {
      this.workspace = workspace;
    }
  }

  return { Workspace: MockWorkspace, WorkspaceFileSystem: MockWorkspaceFileSystem };
});

vi.mock("@cloudflare/shell/git", () => ({
  createGit: vi.fn(() => gitMocks),
}));

const sql = {
  exec: () => [],
  run: () => undefined,
};

function workspace(): GitWorkspace {
  return new GitWorkspace(new Workspace({ sql }));
}

describe("GitWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    gitMocks.clone.mockResolvedValue({ cloned: "https://example.com/repo.git", dir: "/" });
    gitMocks.checkout.mockResolvedValue({ ref: "HEAD" });
    gitMocks.branch.mockResolvedValue({ created: "feature" });
    gitMocks.add.mockResolvedValue({ added: "." });
    gitMocks.commit.mockResolvedValue({ oid: "abc123", message: "commit" });
    gitMocks.push.mockResolvedValue({ ok: true, refs: {} });
    gitMocks.status.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates one git client from the workspace filesystem", () => {
    const gitWorkspace = workspace();

    expect(createGit).toHaveBeenCalledTimes(1);
    expect(gitWorkspace.git).toBe(gitMocks);
  });

  it("clones shallowly with noCheckout before checking out HEAD", async () => {
    await workspace().clone("https://example.com/repo.git", "token-123");

    expect(gitMocks.clone).toHaveBeenCalledWith({
      url: "https://example.com/repo.git",
      depth: 1,
      noCheckout: true,
      token: "token-123",
    });
    expect(gitMocks.checkout).toHaveBeenCalledWith({ ref: "HEAD" });
  });

  it("checks out an existing branch when branch creation reports it already exists", async () => {
    gitMocks.branch.mockRejectedValueOnce(new Error("branch already exists"));

    await workspace().createBranch("feature");

    expect(gitMocks.branch).toHaveBeenCalledWith({ name: "feature" });
    expect(gitMocks.checkout).toHaveBeenCalledWith({ ref: "feature" });
  });

  it("propagates unexpected branch creation errors", async () => {
    const error = new Error("permission denied");
    gitMocks.branch.mockRejectedValueOnce(error);

    await expect(workspace().createBranch("feature")).rejects.toBe(error);
    expect(gitMocks.checkout).not.toHaveBeenCalled();
  });

  it("commits with default author and skips push without a token", async () => {
    const sha = await workspace().commitAndPush({ branch: "feature", message: "Fix bug" });

    expect(sha).toBe("abc123");
    expect(gitMocks.add).toHaveBeenCalledWith({ filepath: "." });
    expect(gitMocks.commit).toHaveBeenCalledWith({
      message: "Fix bug",
      author: { name: "Flarbor Agent", email: "agent@flarbor.dev" },
    });
    expect(gitMocks.push).not.toHaveBeenCalled();
  });

  it("pushes when a token is provided", async () => {
    await workspace().commitAndPush({ branch: "feature", message: "Fix bug", token: "token-123" });

    expect(gitMocks.push).toHaveBeenCalledWith({ token: "token-123" });
  });

  it("returns only changed file paths from git status", async () => {
    gitMocks.status.mockResolvedValueOnce([
      { filepath: "src/index.ts", status: "modified" },
      { filepath: "README.md", status: "unmodified" },
      { filepath: "src/new.ts", status: "added" },
    ]);

    await expect(workspace().getChangedFiles()).resolves.toEqual(["src/index.ts", "src/new.ts"]);
  });
});

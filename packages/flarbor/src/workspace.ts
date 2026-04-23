import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit, type Git } from "@cloudflare/shell/git";
import type { GitConfig } from "./types.js";

const DEFAULT_GIT_CONFIG: GitConfig = {
  authorName: "Flarbor Agent",
  authorEmail: "agent@flarbor.dev",
};

/**
 * GitWorkspace wraps a Workspace and a Git handle together.
 * The Git handle is created once and reused across all operations,
 * avoiding repeated construction of WorkspaceFileSystem + createGit.
 */
export class GitWorkspace {
  readonly workspace: Workspace;
  readonly git: Git;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    const fs = new WorkspaceFileSystem(workspace);
    this.git = createGit(fs);
  }

  /**
   * Clone a repository into the workspace.
   *
   * Uses noCheckout + separate checkout to avoid a known isomorphic-git
   * issue where lstat returns null for freshly-written files during
   * checkout on virtual filesystems, causing TypeError noise in console.
   */
  async clone(repoUrl: string, token?: string): Promise<void> {
    await this.git.clone({
      url: repoUrl,
      depth: 1,
      noCheckout: true,
      ...(token ? { token } : {}),
    });
    await this.git.checkout({ ref: "HEAD" });
  }

  /**
   * Create a new branch and check it out.
   * If the branch already exists, just checks it out.
   */
  async createBranch(branch: string): Promise<void> {
    try {
      await this.git.branch({ name: branch });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) {
        throw err;
      }
    }
    await this.git.checkout({ ref: branch });
  }

  /**
   * Stage all changes, commit, and optionally push.
   * Returns the commit SHA.
   */
  async commitAndPush(opts: {
    branch: string;
    message: string;
    token?: string;
    gitConfig?: GitConfig;
  }): Promise<string> {
    const config = opts.gitConfig ?? DEFAULT_GIT_CONFIG;

    await this.git.add({ filepath: "." });

    const result = await this.git.commit({
      message: opts.message,
      author: {
        name: config.authorName,
        email: config.authorEmail,
      },
    });

    if (opts.token) {
      await this.git.push({ token: opts.token });
    }

    return result.oid;
  }

  /**
   * Get the list of files that differ from HEAD.
   */
  async getChangedFiles(): Promise<string[]> {
    const entries = await this.git.status();
    return entries
      .filter((entry) => entry.status !== "unmodified")
      .map((entry) => entry.filepath);
  }
}

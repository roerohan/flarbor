import { Workspace, WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit, type Git } from "@cloudflare/shell/git";
import type { GitConfig } from "./types.js";

const DEFAULT_GIT_CONFIG: GitConfig = {
  authorName: "Flarbor Agent",
  authorEmail: "agent@flarbor.dev",
};

export class GitWorkspace {
  readonly workspace: Workspace;
  readonly git: Git;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    const fs = new WorkspaceFileSystem(workspace);
    this.git = createGit(fs);
  }

  /**
   * Uses noCheckout + separate checkout to work around an isomorphic-git issue
   * where lstat returns null for freshly-written files on virtual filesystems.
   */
  async clone(repoUrl: string, token?: string): Promise<void> {
    const start = Date.now();
    console.log(`[flarbor:git] clone url=${repoUrl} depth=1 auth=${token ? "token" : "none"}`);
    try {
      await this.git.clone({
        url: repoUrl,
        depth: 1,
        noCheckout: true,
        ...(token ? { token } : {}),
      });
      await this.git.checkout({ ref: "HEAD" });
      console.log(`[flarbor:git] clone complete duration=${Date.now() - start}ms`);
    } catch (err) {
      console.error(`[flarbor:git] clone failed duration=${Date.now() - start}ms error=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async createBranch(branch: string): Promise<void> {
    console.log(`[flarbor:git] create_branch branch=${branch}`);
    try {
      await this.git.branch({ name: branch });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already exists")) throw err;
      console.log(`[flarbor:git] branch already exists, checking out branch=${branch}`);
    }
    await this.git.checkout({ ref: branch });
  }

  async commitAndPush(opts: {
    branch: string;
    message: string;
    token?: string;
    gitConfig?: GitConfig;
  }): Promise<string> {
    const start = Date.now();
    const config = opts.gitConfig ?? DEFAULT_GIT_CONFIG;

    await this.git.add({ filepath: "." });
    const result = await this.git.commit({
      message: opts.message,
      author: { name: config.authorName, email: config.authorEmail },
    });
    console.log(`[flarbor:git] commit sha=${result.oid} branch=${opts.branch} author=${config.authorName}`);

    if (opts.token) {
      const pushStart = Date.now();
      console.log(`[flarbor:git] push branch=${opts.branch}`);
      try {
        await this.git.push({ token: opts.token });
        console.log(`[flarbor:git] push complete duration=${Date.now() - pushStart}ms`);
      } catch (err) {
        console.error(`[flarbor:git] push failed duration=${Date.now() - pushStart}ms error=${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    } else {
      console.warn("[flarbor:git] push skipped, no token provided");
    }

    console.log(`[flarbor:git] commit_and_push complete duration=${Date.now() - start}ms sha=${result.oid}`);
    return result.oid;
  }

  async getChangedFiles(): Promise<string[]> {
    const entries = await this.git.status();
    const changed = entries
      .filter((entry) => entry.status !== "unmodified")
      .map((entry) => entry.filepath);
    console.log(`[flarbor:git] status changed_files=${changed.length} files=[${changed.join(",")}]`);
    return changed;
  }
}

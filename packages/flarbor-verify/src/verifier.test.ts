import { describe, expect, it } from "vitest";

import { createNoExec, defineVerifier, requireExec, rewards, verify } from "./index.js";
import type { VerifyContext, WorkspaceLike } from "./types.js";

const workspace: WorkspaceLike = {
  async readFile(path) {
    return path === "README.md" ? "health endpoint" : null;
  },
  async readDir() {
    return [];
  },
};

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    workspace,
    filesChanged: [],
    success: true,
    capabilities: {},
    ...overrides,
  };
}

describe("verify", () => {
  it("runs a native verifier without exec", async () => {
    const verifier = defineVerifier({
      name: "docs",
      async run(ctx) {
        const readme = await ctx.workspace.readFile("README.md");
        return rewards({ docs_updated: readme?.includes("health") ? 1 : 0 });
      },
    });

    await expect(verify({ verifier, context: context() })).resolves.toMatchObject({
      kind: "verified",
      rewards: { docs_updated: 1 },
      mode: "native",
    });
  });

  it("returns a typed error when exec is required but unavailable", async () => {
    const verifier = defineVerifier({
      name: "needs-exec",
      async run(ctx) {
        await requireExec(ctx.capabilities).run({ command: "npm test" });
        return rewards({ tests: 1 });
      },
    });

    await expect(verify({ verifier, context: context() })).resolves.toMatchObject({
      kind: "error",
      error: { code: "EXEC_UNAVAILABLE" },
    });
  });

  it("supports explicit no-exec capability results", async () => {
    await expect(createNoExec().run({ command: "npm test" })).rejects.toMatchObject({
      error: { code: "EXEC_UNAVAILABLE" },
    });
  });
});

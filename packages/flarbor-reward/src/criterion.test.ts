import { describe, expect, it } from "vitest";
import { criterion } from "./criterion.js";
import type { CriterionContext, WorkspaceLike } from "./types.js";

function workspace(): WorkspaceLike {
  return {
    async readFile() {
      return null;
    },
    async readDir() {
      return [];
    },
  };
}

function context(): CriterionContext {
  return { workspace: workspace(), filesChanged: [], success: true };
}

describe("criterion", () => {
  it("preserves metadata and defaults weight to 1", async () => {
    const c = criterion({
      name: "passes",
      description: "a passing criterion",
      evaluate: () => true,
    });

    expect(c.name).toBe("passes");
    expect(c.description).toBe("a passing criterion");
    expect(c.weight).toBe(1);
    await expect(c.evaluate(context())).resolves.toBe(true);
  });

  it("preserves explicit weight and wraps synchronous numeric results", async () => {
    const c = criterion({ name: "partial", weight: 2.5, evaluate: () => 0.25 });

    expect(c.weight).toBe(2.5);
    await expect(c.evaluate(context())).resolves.toBe(0.25);
  });

  it("passes the context to asynchronous evaluators", async () => {
    const c = criterion({
      name: "changed",
      evaluate: async (ctx) => ctx.filesChanged.includes("src/index.ts"),
    });

    await expect(c.evaluate({ ...context(), filesChanged: ["src/index.ts"] })).resolves.toBe(true);
  });
});

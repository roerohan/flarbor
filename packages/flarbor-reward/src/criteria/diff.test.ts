import { describe, expect, it } from "vitest";
import { diffSize, diffTouchesOnly, hasChanges, noDeletions } from "./diff.js";
import type { CriterionContext, WorkspaceLike } from "../types.js";

function workspace(files: Record<string, string>): WorkspaceLike {
  return {
    async readFile(path) {
      return Object.hasOwn(files, path) ? files[path] : null;
    },
    async readDir() {
      return Object.keys(files).map((path) => ({ path, type: "file" }));
    },
  };
}

function context(filesChanged: string[], files: Record<string, string> = {}): CriterionContext {
  return { workspace: workspace(files), filesChanged, success: true };
}

describe("diff criteria", () => {
  it("detects whether any files changed", async () => {
    await expect(hasChanges().evaluate(context([]))).resolves.toBe(false);
    await expect(hasChanges().evaluate(context(["src/a.ts"]))).resolves.toBe(true);
  });

  it("scores diff size at, between, and beyond the file budget", async () => {
    await expect(diffSize(2).evaluate(context([]))).resolves.toBe(1);
    await expect(diffSize(2).evaluate(context(["a", "b"]))).resolves.toBe(1);
    await expect(diffSize(2).evaluate(context(["a", "b", "c"]))).resolves.toBe(0.5);
    await expect(diffSize(2).evaluate(context(["a", "b", "c", "d"]))).resolves.toBe(0);
    await expect(diffSize(0).evaluate(context(["a"]))).resolves.toBe(0);
  });

  it("requires changed files to match allowed glob patterns", async () => {
    await expect(
      diffTouchesOnly(["src/**/*.ts", "README.md"]).evaluate(
        context(["src/nested/a.ts", "README.md"]),
      ),
    ).resolves.toBe(true);
    await expect(
      diffTouchesOnly(["src/**/*.ts"]).evaluate(context(["src/nested/a.ts", "package.json"])),
    ).resolves.toBe(false);
    await expect(diffTouchesOnly([]).evaluate(context([]))).resolves.toBe(true);
    await expect(diffTouchesOnly([]).evaluate(context(["src/a.ts"]))).resolves.toBe(false);
  });

  it("treats missing changed files as deletions", async () => {
    await expect(noDeletions().evaluate(context([], {}))).resolves.toBe(true);
    await expect(
      noDeletions().evaluate(
        context(["src/a.ts", "src/b.ts"], { "src/a.ts": "a", "src/b.ts": "b" }),
      ),
    ).resolves.toBe(true);
    await expect(
      noDeletions().evaluate(context(["src/a.ts", "src/b.ts"], { "src/a.ts": "a" })),
    ).resolves.toBe(false);
  });
});

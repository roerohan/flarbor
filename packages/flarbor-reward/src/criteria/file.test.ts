import { describe, expect, it } from "vitest";
import {
  diffRatio,
  fileContains,
  fileContainsRegex,
  fileExists,
  fileMatches,
  fileNotExists,
  filesEqual,
} from "./file.js";
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

function context(files: Record<string, string>): CriterionContext {
  return { workspace: workspace(files), filesChanged: Object.keys(files), success: true };
}

describe("file criteria", () => {
  it("checks file existence and absence", async () => {
    const ctx = context({ "src/a.ts": "content" });

    await expect(fileExists("src/a.ts").evaluate(ctx)).resolves.toBe(true);
    await expect(fileExists("missing.ts").evaluate(ctx)).resolves.toBe(false);
    await expect(fileNotExists("missing.ts").evaluate(ctx)).resolves.toBe(true);
    await expect(fileNotExists("src/a.ts").evaluate(ctx)).resolves.toBe(false);
  });

  it("checks literal and regex content matches", async () => {
    const ctx = context({ "src/a.ts": "export const value = 42;" });

    await expect(fileContains("src/a.ts", "value = 42").evaluate(ctx)).resolves.toBe(true);
    await expect(fileContains("src/a.ts", "missing").evaluate(ctx)).resolves.toBe(false);
    await expect(fileContains("missing.ts", "value").evaluate(ctx)).resolves.toBe(false);
    await expect(fileContainsRegex("src/a.ts", "value\\s*=\\s*42").evaluate(ctx)).resolves.toBe(
      true,
    );
    await expect(fileContainsRegex("src/a.ts", /VALUE/i).evaluate(ctx)).resolves.toBe(true);
    await expect(fileContainsRegex("missing.ts", /VALUE/i).evaluate(ctx)).resolves.toBe(false);
  });

  it("matches trimmed whole-file content", async () => {
    const ctx = context({ "README.md": "\nhello\n" });

    await expect(fileMatches("README.md", "hello").evaluate(ctx)).resolves.toBe(true);
    await expect(fileMatches("README.md", "hello!").evaluate(ctx)).resolves.toBe(false);
    await expect(fileMatches("missing.md", "hello").evaluate(ctx)).resolves.toBe(false);
  });

  it("compares files for exact equality", async () => {
    const ctx = context({ "a.txt": "same", "b.txt": "same", "c.txt": "different" });

    await expect(filesEqual("a.txt", "b.txt").evaluate(ctx)).resolves.toBe(true);
    await expect(filesEqual("a.txt", "c.txt").evaluate(ctx)).resolves.toBe(false);
    await expect(filesEqual("a.txt", "missing.txt").evaluate(ctx)).resolves.toBe(false);
  });

  it("scores content similarity with edge cases", async () => {
    await expect(
      diffRatio("a.txt", "same").evaluate(context({ "a.txt": " same\n" })),
    ).resolves.toBe(1);
    await expect(diffRatio("a.txt", "").evaluate(context({ "a.txt": "\n" }))).resolves.toBe(1);
    await expect(diffRatio("a.txt", "b").evaluate(context({ "a.txt": "a" }))).resolves.toBe(0);
    await expect(
      diffRatio("a.txt", "abxy").evaluate(context({ "a.txt": "abcd" })),
    ).resolves.toBeCloseTo(1 / 3);
    await expect(diffRatio("missing.txt", "expected").evaluate(context({}))).resolves.toBe(0);
  });
});

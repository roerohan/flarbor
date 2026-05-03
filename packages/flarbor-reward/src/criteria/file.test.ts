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
import { mockContext } from "flarbor-shared/testing";

describe("file criteria", () => {
  it("checks file existence and absence", async () => {
    const ctx = mockContext({ files: { "src/a.ts": "content" } });

    await expect(fileExists("src/a.ts").evaluate(ctx)).resolves.toBe(true);
    await expect(fileExists("missing.ts").evaluate(ctx)).resolves.toBe(false);
    await expect(fileNotExists("missing.ts").evaluate(ctx)).resolves.toBe(true);
    await expect(fileNotExists("src/a.ts").evaluate(ctx)).resolves.toBe(false);
  });

  it("checks literal and regex content matches", async () => {
    const ctx = mockContext({ files: { "src/a.ts": "export const value = 42;" } });

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
    const ctx = mockContext({ files: { "README.md": "\nhello\n" } });

    await expect(fileMatches("README.md", "hello").evaluate(ctx)).resolves.toBe(true);
    await expect(fileMatches("README.md", "hello!").evaluate(ctx)).resolves.toBe(false);
    await expect(fileMatches("missing.md", "hello").evaluate(ctx)).resolves.toBe(false);
  });

  it("compares files for exact equality", async () => {
    const ctx = mockContext({ files: { "a.txt": "same", "b.txt": "same", "c.txt": "different" } });

    await expect(filesEqual("a.txt", "b.txt").evaluate(ctx)).resolves.toBe(true);
    await expect(filesEqual("a.txt", "c.txt").evaluate(ctx)).resolves.toBe(false);
    await expect(filesEqual("a.txt", "missing.txt").evaluate(ctx)).resolves.toBe(false);
  });

  it("scores content similarity with edge cases", async () => {
    await expect(
      diffRatio("a.txt", "same").evaluate(mockContext({ files: { "a.txt": " same\n" } })),
    ).resolves.toBe(1);
    await expect(
      diffRatio("a.txt", "").evaluate(mockContext({ files: { "a.txt": "\n" } })),
    ).resolves.toBe(1);
    await expect(
      diffRatio("a.txt", "b").evaluate(mockContext({ files: { "a.txt": "a" } })),
    ).resolves.toBe(0);
    await expect(
      diffRatio("a.txt", "abxy").evaluate(mockContext({ files: { "a.txt": "abcd" } })),
    ).resolves.toBeCloseTo(1 / 3);
    await expect(diffRatio("missing.txt", "expected").evaluate(mockContext())).resolves.toBe(0);
  });

  it("uses multiset bigrams for correct Sorensen-Dice", async () => {
    // "aaa" -> bigrams ["aa", "aa"] (count 2), "aab" -> bigrams ["aa", "ab"] (count 1 each)
    // Multiset intersection: min(2,1) for "aa" + min(0,1) for "ab" = 1
    // Multiset sizes: 2 + 2 = 4, score = 2*1/4 = 0.5
    // (With Set-based dedup, both would have {"aa"} and {"aa","ab"}, giving 2*1/3 ≈ 0.667)
    await expect(
      diffRatio("a.txt", "aab").evaluate(mockContext({ files: { "a.txt": "aaa" } })),
    ).resolves.toBeCloseTo(0.5);
  });
});

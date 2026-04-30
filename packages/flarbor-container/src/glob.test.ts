import { describe, expect, it } from "vitest";

import { globToRegex, matchesGlob } from "./glob.js";

describe("globToRegex", () => {
  it("anchors matches to the entire path", () => {
    const regex = globToRegex("src/*.ts");

    expect(regex.test("src/index.ts")).toBe(true);
    expect(regex.test("prefix/src/index.ts")).toBe(false);
    expect(regex.test("src/index.ts.bak")).toBe(false);
  });

  it("keeps single stars and question marks within one path segment", () => {
    const star = globToRegex("src/*.ts");
    const question = globToRegex("src/file-?.ts");

    expect(star.test("src/index.ts")).toBe(true);
    expect(star.test("src/nested/index.ts")).toBe(false);
    expect(question.test("src/file-a.ts")).toBe(true);
    expect(question.test("src/file-ab.ts")).toBe(false);
    expect(question.test("src/file-/.ts")).toBe(false);
  });

  it("treats globstar slash as zero or more directories", () => {
    const regex = globToRegex("src/**/*.ts");

    expect(regex.test("src/index.ts")).toBe(true);
    expect(regex.test("src/a/b/index.ts")).toBe(true);
    expect(regex.test("src/a/b/index.js")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    const regex = globToRegex("docs/v1.0/[draft](1).md");

    expect(regex.test("docs/v1.0/[draft](1).md")).toBe(true);
    expect(regex.test("docs/v10/[draft](1).md")).toBe(false);
    expect(regex.test("docs/v1.0/draft1.md")).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("returns true when any pattern matches", () => {
    expect(matchesGlob("README.md", ["src/**/*.ts", "**/*"])).toBe(true);
    expect(matchesGlob("src/index.ts", ["README.md", "src/*.ts"])).toBe(true);
  });

  it("returns false when no patterns match", () => {
    expect(matchesGlob("src/nested/index.ts", ["README.md", "src/*.ts"])).toBe(false);
    expect(matchesGlob("src/index.ts", [])).toBe(false);
  });
});

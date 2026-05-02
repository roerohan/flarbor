import { describe, expect, it } from "vitest";

import { globToRegex, matchesGlob } from "./glob.js";

describe("globToRegex", () => {
  it("matches stars within a single path segment", () => {
    const regex = globToRegex("src/*.ts");

    expect(regex.test("src/index.ts")).toBe(true);
    expect(regex.test("src/nested/index.ts")).toBe(false);
    expect(regex.test("src/index.js")).toBe(false);
  });

  it("matches globstars across path separators", () => {
    const regex = globToRegex("src/**/*.ts");

    expect(regex.test("src/nested/index.ts")).toBe(true);
    expect(regex.test("src/a/b/c.ts")).toBe(true);
    expect(regex.test("test/a/b/c.ts")).toBe(false);
  });

  it("escapes regex metacharacters in literal path segments", () => {
    const regex = globToRegex("docs/v1.0/[draft].md");

    expect(regex.test("docs/v1.0/[draft].md")).toBe(true);
    expect(regex.test("docs/v10/[draft].md")).toBe(false);
    expect(regex.test("docs/v1.0/d.md")).toBe(false);
  });

  it("anchors matches to the full path", () => {
    const regex = globToRegex("README.md");

    expect(regex.test("README.md")).toBe(true);
    expect(regex.test("docs/README.md")).toBe(false);
    expect(regex.test("README.md.bak")).toBe(false);
  });

  it("matches ? as a single non-separator character", () => {
    const regex = globToRegex("src/?.ts");

    expect(regex.test("src/a.ts")).toBe(true);
    expect(regex.test("src/ab.ts")).toBe(false);
    expect(regex.test("src//.ts")).toBe(false);
  });

  it("handles **/ as an optional prefix", () => {
    const regex = globToRegex("**/foo.ts");

    expect(regex.test("foo.ts")).toBe(true);
    expect(regex.test("src/foo.ts")).toBe(true);
    expect(regex.test("src/nested/foo.ts")).toBe(true);
  });

  it("matches .git/** pattern", () => {
    const regex = globToRegex(".git/**");

    expect(regex.test(".git/config")).toBe(true);
    expect(regex.test(".git/refs/heads/main")).toBe(true);
    expect(regex.test(".github/workflows/ci.yml")).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("returns true when any pattern matches", () => {
    expect(matchesGlob("src/index.ts", ["README.md", "src/*.ts"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchesGlob("src/nested/index.ts", ["README.md", "src/*.ts"])).toBe(false);
  });

  it("returns false for an empty pattern list", () => {
    expect(matchesGlob("src/index.ts", [])).toBe(false);
  });
});

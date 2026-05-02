import { describe, expect, it } from "vitest";
import { diffSize, diffTouchesOnly, hasChanges, noDeletions } from "./diff.js";
import { mockContext } from "flarbor-shared/testing";

describe("diff criteria", () => {
  it("detects whether any files changed", async () => {
    await expect(hasChanges().evaluate(mockContext())).resolves.toBe(false);
    await expect(
      hasChanges().evaluate(mockContext({ filesChanged: ["src/a.ts"] })),
    ).resolves.toBe(true);
  });

  it("scores diff size at, between, and beyond the file budget", async () => {
    await expect(diffSize(2).evaluate(mockContext())).resolves.toBe(1);
    await expect(
      diffSize(2).evaluate(mockContext({ filesChanged: ["a", "b"] })),
    ).resolves.toBe(1);
    await expect(
      diffSize(2).evaluate(mockContext({ filesChanged: ["a", "b", "c"] })),
    ).resolves.toBe(0.5);
    await expect(
      diffSize(2).evaluate(mockContext({ filesChanged: ["a", "b", "c", "d"] })),
    ).resolves.toBe(0);
    await expect(
      diffSize(0).evaluate(mockContext({ filesChanged: ["a"] })),
    ).resolves.toBe(0);
  });

  it("requires changed files to match allowed glob patterns", async () => {
    await expect(
      diffTouchesOnly(["src/**/*.ts", "README.md"]).evaluate(
        mockContext({ filesChanged: ["src/nested/a.ts", "README.md"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      diffTouchesOnly(["src/**/*.ts"]).evaluate(
        mockContext({ filesChanged: ["src/nested/a.ts", "package.json"] }),
      ),
    ).resolves.toBe(false);
    await expect(diffTouchesOnly([]).evaluate(mockContext())).resolves.toBe(true);
    await expect(
      diffTouchesOnly([]).evaluate(mockContext({ filesChanged: ["src/a.ts"] })),
    ).resolves.toBe(false);
  });

  it("treats missing changed files as deletions", async () => {
    await expect(noDeletions().evaluate(mockContext())).resolves.toBe(true);
    await expect(
      noDeletions().evaluate(
        mockContext({
          filesChanged: ["src/a.ts", "src/b.ts"],
          files: { "src/a.ts": "a", "src/b.ts": "b" },
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      noDeletions().evaluate(
        mockContext({
          filesChanged: ["src/a.ts", "src/b.ts"],
          files: { "src/a.ts": "a" },
        }),
      ),
    ).resolves.toBe(false);
  });
});

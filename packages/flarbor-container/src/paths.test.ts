import { describe, expect, it } from "vitest";

import {
  joinSandboxPath,
  normalizeRelativeDirectory,
  normalizeRelativePath,
  normalizeSandboxRoot,
} from "./paths.js";
import { ContainerCommandError } from "./types.js";

describe("normalizeRelativePath", () => {
  it("normalizes leading dot-slash and Windows separators", () => {
    expect(normalizeRelativePath("./src/index.ts")).toBe("src/index.ts");
    expect(normalizeRelativePath("src\\index.ts")).toBe("src/index.ts");
  });

  it("rejects empty, absolute, parent, duplicate separator, and null-byte paths", () => {
    expectInvalidRelative("");
    expectInvalidRelative("/src/index.ts");
    expectInvalidRelative("src/../index.ts");
    expectInvalidRelative("src//index.ts");
    expectInvalidRelative("src/\0index.ts");
  });
});

describe("normalizeRelativeDirectory", () => {
  it("defaults omitted and root-like directories to dot", () => {
    expect(normalizeRelativeDirectory(undefined)).toBe(".");
    expect(normalizeRelativeDirectory("")).toBe(".");
    expect(normalizeRelativeDirectory(".")).toBe(".");
  });

  it("normalizes and rejects directories using relative path rules", () => {
    expect(normalizeRelativeDirectory("./packages/app")).toBe("packages/app");
    expect(() => normalizeRelativeDirectory("../app")).toThrow(ContainerCommandError);
  });
});

describe("joinSandboxPath", () => {
  it("joins normalized relative paths under the sandbox root", () => {
    expect(joinSandboxPath("/workspace/repo", ".")).toBe("/workspace/repo");
    expect(joinSandboxPath("/workspace/repo", "src/index.ts")).toBe("/workspace/repo/src/index.ts");
    expect(joinSandboxPath("/workspace/repo", "src\\index.ts")).toBe(
      "/workspace/repo/src/index.ts",
    );
  });
});

describe("normalizeSandboxRoot", () => {
  it("accepts absolute roots under /workspace and removes trailing slashes", () => {
    expect(normalizeSandboxRoot("/workspace/repo/")).toBe("/workspace/repo");
    expect(normalizeSandboxRoot("/workspace/repo/packages_app-1.2")).toBe(
      "/workspace/repo/packages_app-1.2",
    );
  });

  it("rejects roots outside /workspace or with unsafe segments", () => {
    expectInvalidRoot("/workspace");
    expectInvalidRoot("/tmp/repo");
    expectInvalidRoot("/workspace/repo/../other");
    expectInvalidRoot("/workspace/repo//nested");
    expectInvalidRoot("/workspace/repo/with space");
    expectInvalidRoot("/workspace/repo\0");
  });
});

function expectInvalidRelative(path: string): void {
  expect(() => normalizeRelativePath(path)).toThrow(ContainerCommandError);
}

function expectInvalidRoot(path: string): void {
  expect(() => normalizeSandboxRoot(path)).toThrow(ContainerCommandError);
}

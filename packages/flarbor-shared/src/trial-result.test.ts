import { describe, expect, it } from "vitest";
import { isTrialResult } from "./trial-result.js";

describe("isTrialResult", () => {
  it("accepts a valid minimal TrialResult", () => {
    expect(
      isTrialResult({
        success: true,
        branch: "main",
        commitSha: "abc123",
        filesChanged: ["src/index.ts"],
      }),
    ).toBe(true);
  });

  it("accepts a result with extra fields", () => {
    expect(
      isTrialResult({
        success: false,
        branch: "",
        commitSha: "",
        filesChanged: [],
        error: "something went wrong",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isTrialResult(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isTrialResult(undefined)).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isTrialResult("string")).toBe(false);
    expect(isTrialResult(42)).toBe(false);
    expect(isTrialResult(true)).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(isTrialResult({})).toBe(false);
  });

  it("rejects when success is not boolean", () => {
    expect(
      isTrialResult({ success: "true", branch: "main", commitSha: "a", filesChanged: [] }),
    ).toBe(false);
  });

  it("rejects when branch is not string", () => {
    expect(
      isTrialResult({ success: true, branch: 123, commitSha: "a", filesChanged: [] }),
    ).toBe(false);
  });

  it("rejects when commitSha is not string", () => {
    expect(
      isTrialResult({ success: true, branch: "main", commitSha: null, filesChanged: [] }),
    ).toBe(false);
  });

  it("rejects when filesChanged is not an array", () => {
    expect(
      isTrialResult({ success: true, branch: "main", commitSha: "a", filesChanged: "file.ts" }),
    ).toBe(false);
  });

  it("rejects when a required field is missing", () => {
    expect(isTrialResult({ success: true, branch: "main", commitSha: "a" })).toBe(false);
    expect(isTrialResult({ success: true, branch: "main", filesChanged: [] })).toBe(false);
    expect(isTrialResult({ success: true, commitSha: "a", filesChanged: [] })).toBe(false);
    expect(isTrialResult({ branch: "main", commitSha: "a", filesChanged: [] })).toBe(false);
  });
});

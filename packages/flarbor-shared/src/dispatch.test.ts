import { describe, expect, it } from "vitest";
import { agentNameFor, dispatchTask, DispatchError } from "./dispatch.js";
import type { FetcherLike } from "./dispatch.js";

function stubFetcher(response: Response): FetcherLike {
  return { fetch: async () => response };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const validResult = {
  success: true,
  branch: "main",
  commitSha: "abc123",
  filesChanged: ["src/a.ts"],
};

const task = { repoUrl: "https://github.com/test/repo", branch: "feat" };

describe("agentNameFor", () => {
  it("derives name from repoUrl and branch", () => {
    expect(agentNameFor({ repoUrl: "https://github.com/x/y", branch: "main" })).toBe(
      "https://github.com/x/y:main",
    );
  });

  it("uses 'default' when branch is omitted", () => {
    expect(agentNameFor({ repoUrl: "https://github.com/x/y" })).toBe(
      "https://github.com/x/y:default",
    );
  });
});

describe("dispatchTask", () => {
  it("returns a valid TrialResult on success", async () => {
    const stub = stubFetcher(jsonResponse(validResult));
    const result = await dispatchTask(stub, task);
    expect(result).toEqual(validResult);
  });

  it("returns a failed TrialResult (success: false) without throwing", async () => {
    const failedResult = { ...validResult, success: false, error: "agent error" };
    const stub = stubFetcher(jsonResponse(failedResult, 500));
    const result = await dispatchTask(stub, task);
    expect(result.success).toBe(false);
    expect(result.error).toBe("agent error");
  });

  it("throws DispatchError with kind=fetch_failed on network error", async () => {
    const stub: FetcherLike = {
      fetch: async () => {
        throw new Error("connection refused");
      },
    };
    await expect(dispatchTask(stub, task)).rejects.toThrow(DispatchError);
    try {
      await dispatchTask(stub, task);
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).kind).toBe("fetch_failed");
      expect((err as DispatchError).message).toContain("connection refused");
    }
  });

  it("throws DispatchError with kind=invalid_json on non-JSON response", async () => {
    const stub = stubFetcher(new Response("not json", { status: 200 }));
    await expect(dispatchTask(stub, task)).rejects.toThrow(DispatchError);
    try {
      await dispatchTask(stub, task);
    } catch (err) {
      expect((err as DispatchError).kind).toBe("invalid_json");
      expect((err as DispatchError).status).toBe(200);
    }
  });

  it("throws DispatchError with kind=invalid_result when shape is wrong", async () => {
    const stub = stubFetcher(jsonResponse({ foo: "bar" }));
    await expect(dispatchTask(stub, task)).rejects.toThrow(DispatchError);
    try {
      await dispatchTask(stub, task);
    } catch (err) {
      expect((err as DispatchError).kind).toBe("invalid_result");
    }
  });

  it("throws DispatchError with kind=invalid_result when required field is missing", async () => {
    const stub = stubFetcher(jsonResponse({ success: true, branch: "main" }));
    await expect(dispatchTask(stub, task)).rejects.toThrow(DispatchError);
    try {
      await dispatchTask(stub, task);
    } catch (err) {
      expect((err as DispatchError).kind).toBe("invalid_result");
    }
  });
});

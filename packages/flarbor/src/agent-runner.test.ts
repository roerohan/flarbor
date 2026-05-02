import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTask } from "./agent-runner.js";
import type { TaskConfig, TrialResult } from "./types.js";

function task(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    repoUrl: "https://example.com/repo.git",
    instructions: "Fix the bug",
    ...overrides,
  };
}

describe("runTask", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a JSON POST request to the agent room", async () => {
    const result: TrialResult = {
      success: true,
      branch: "fix-branch",
      commitSha: "abc123",
      filesChanged: ["src/index.ts"],
    };
    const fetch = vi.fn(async () => Response.json(result));

    const actual = await runTask({ fetch }, task({ branch: "fix-branch" }));

    expect(actual).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("http://internal/run");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.headers.get("x-partykit-room")).toBe("https://example.com/repo.git:fix-branch");
    expect(await request?.json()).toEqual(task({ branch: "fix-branch" }));
  });

  it("uses default room suffix when no branch is provided", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ success: true, branch: "generated", commitSha: "abc", filesChanged: [] }),
    );

    await runTask({ fetch }, task());

    const request = fetch.mock.calls[0]?.[0];
    expect(request?.headers.get("x-partykit-room")).toBe("https://example.com/repo.git:default");
  });

  it("returns a failed trial result when fetch throws", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(runTask({ fetch }, task({ branch: "existing" }))).resolves.toMatchObject({
      success: false,
      branch: "existing",
      commitSha: "",
      filesChanged: [],
      error: "Failed to reach agent: network down",
    });
  });

  it("returns a failed trial result for invalid response shapes", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }, { status: 202 }));

    const result = await runTask({ fetch }, task());
    expect(result.success).toBe(false);
    expect(result.branch).toBe("");
    expect(result.commitSha).toBe("");
    expect(result.filesChanged).toEqual([]);
    expect(result.error).toContain("Agent returned invalid TrialResult (status 202)");
  });

  it("includes unreadable JSON response text in parse failures", async () => {
    const fetch = vi.fn(async () => new Response("not json", { status: 502 }));

    const result = await runTask({ fetch }, task({ branch: "b" }));
    expect(result.success).toBe(false);
    expect(result.branch).toBe("b");
    expect(result.error).toContain("502");
    expect(result.error).toContain("not json");
  });
});

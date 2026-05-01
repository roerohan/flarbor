import { describe, expect, it } from "vitest";
import { runTrial } from "./trial.js";
import type { TrialConfig } from "./types.js";

const trial: TrialConfig = {
  id: "job-1:task-a:agent-a:1",
  jobId: "job-1",
  taskId: "task-a",
  agentId: "agent-a",
  attempt: 1,
  task: {
    repoUrl: "https://github.com/example/repo",
    instructions: "fix it",
  },
};

describe("runTrial", () => {
  it("retries orchestration fetch failures", async () => {
    let fetches = 0;

    const record = await runTrial(trial, {
      agent: { id: "agent-a", kind: "durable_object", namespace: "FLARBOR_AGENT" },
      retry: { maxRetries: 1, minDelayMs: 0 },
      resolveAgent: () => ({
        fetch: async () => {
          fetches += 1;
          if (fetches === 1) throw new Error("temporary network failure");
          return Response.json({
            success: true,
            branch: "main",
            commitSha: "abc123",
            filesChanged: [],
          });
        },
      }),
    });

    expect(fetches).toBe(2);
    expect(record.status).toBe("succeeded");
    expect(record.tries).toBe(2);
  });

  it("retries invalid agent responses", async () => {
    let fetches = 0;

    const record = await runTrial(trial, {
      agent: { id: "agent-a", kind: "durable_object", namespace: "FLARBOR_AGENT" },
      retry: { maxRetries: 1, minDelayMs: 0 },
      resolveAgent: () => ({
        fetch: async () => {
          fetches += 1;
          if (fetches === 1) return Response.json({ success: true });
          return Response.json({
            success: true,
            branch: "main",
            commitSha: "abc123",
            filesChanged: [],
          });
        },
      }),
    });

    expect(fetches).toBe(2);
    expect(record.status).toBe("succeeded");
    expect(record.tries).toBe(2);
  });

  it("does not retry valid failed trial results by default", async () => {
    let fetches = 0;

    const record = await runTrial(trial, {
      agent: { id: "agent-a", kind: "durable_object", namespace: "FLARBOR_AGENT" },
      retry: { maxRetries: 1, minDelayMs: 0 },
      resolveAgent: () => ({
        fetch: async () => {
          fetches += 1;
          return Response.json({
            success: false,
            branch: "main",
            commitSha: "",
            filesChanged: [],
            error: "agent could not complete the task",
          });
        },
      }),
    });

    expect(fetches).toBe(1);
    expect(record.status).toBe("failed");
    expect(record.tries).toBe(1);
    expect(record.error).toBe("agent could not complete the task");
  });
});

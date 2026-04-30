import { describe, expect, it } from "vitest";
import { computeStats } from "./stats.js";
import type { TrialRecord } from "./types.js";

function record(overrides: Partial<TrialRecord>): TrialRecord {
  return {
    config: {
      id: "trial-1",
      jobId: "job-1",
      taskId: "task-a",
      agentId: "agent-a",
      attempt: 1,
      task: { repoUrl: "https://github.com/example/repo", instructions: "fix it" },
    },
    status: "succeeded",
    tries: 1,
    ...overrides,
  };
}

describe("computeStats", () => {
  it("handles empty records", () => {
    expect(computeStats([])).toEqual({
      total: 0,
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      successRate: 0,
      averageReward: undefined,
      averageTokens: undefined,
      byAgent: {},
      byTask: {},
    });
  });

  it("computes totals, averages, and group stats", () => {
    const stats = computeStats([
      record({
        status: "succeeded",
        result: {
          success: true,
          branch: "main",
          commitSha: "a",
          filesChanged: [],
          reward: { score: 1, rewards: [], totalCriteria: 0, errors: 0 },
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        },
      }),
      record({
        status: "failed",
        config: {
          id: "trial-2",
          jobId: "job-1",
          taskId: "task-a",
          agentId: "agent-b",
          attempt: 1,
          task: { repoUrl: "https://github.com/example/repo", instructions: "fix it" },
        },
        result: {
          success: false,
          branch: "main",
          commitSha: "",
          filesChanged: [],
          reward: { score: 0, rewards: [], totalCriteria: 0, errors: 0 },
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        },
      }),
    ]);

    expect(stats.total).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBe(0.5);
    expect(stats.averageReward).toBe(0.5);
    expect(stats.averageTokens).toBe(7.5);
    expect(stats.byAgent["agent-a"]?.successRate).toBe(1);
    expect(stats.byAgent["agent-b"]?.successRate).toBe(0);
    expect(stats.byTask["task-a"]?.total).toBe(2);
  });
});

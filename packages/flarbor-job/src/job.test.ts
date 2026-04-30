import { describe, expect, it } from "vitest";
import { createJobId, createTrialConfigs, runJob } from "./job.js";
import type { JobConfig } from "./types.js";

function config(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    id: "job-1",
    tasks: [
      {
        id: "task-a",
        task: {
          repoUrl: "https://github.com/example/a",
          instructions: "fix a",
        },
      },
      {
        id: "task-b",
        task: {
          repoUrl: "https://github.com/example/b",
          instructions: "fix b",
        },
      },
    ],
    agents: [
      { id: "agent-a", kind: "durable_object", namespace: "FLARBOR_AGENT" },
      { id: "agent-b", kind: "durable_object", namespace: "FLARBOR_AGENT" },
    ],
    ...overrides,
  };
}

describe("createJobId", () => {
  it("uses explicit IDs when provided", () => {
    expect(createJobId(config({ id: "explicit" }))).toBe("explicit");
  });

  it("creates stable IDs from config content", () => {
    const first = createJobId(config({ id: undefined, name: "stable" }));
    const second = createJobId(config({ id: undefined, name: "stable" }));

    expect(first).toBe(second);
    expect(first.startsWith("job-")).toBe(true);
  });
});

describe("createTrialConfigs", () => {
  it("expands tasks x agents x attempts deterministically", () => {
    const trials = createTrialConfigs(config({ attempts: 2 }));

    expect(trials.map((trial) => trial.id)).toEqual([
      "job-1:task-a:agent-a:1",
      "job-1:task-a:agent-a:2",
      "job-1:task-a:agent-b:1",
      "job-1:task-a:agent-b:2",
      "job-1:task-b:agent-a:1",
      "job-1:task-b:agent-a:2",
      "job-1:task-b:agent-b:1",
      "job-1:task-b:agent-b:2",
    ]);
  });
});

describe("runJob", () => {
  it("emits lifecycle hooks and aggregates successful trials", async () => {
    const events: string[] = [];
    const result = await runJob(
      config({ tasks: [config().tasks[0]], agents: [config().agents[0]] }),
      {
        hooks: [(event) => events.push(event.type)],
        resolveAgent: () => ({
          fetch: async () =>
            Response.json({
              success: true,
              branch: "main",
              commitSha: "abc123",
              filesChanged: ["src/index.ts"],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              reward: { score: 1, rewards: [], totalCriteria: 0, errors: 0 },
            }),
        }),
      },
    );

    expect(events).toEqual(["job_started", "trial_started", "trial_finished", "job_finished"]);
    expect(result.status).toBe("completed");
    expect(result.stats.succeeded).toBe(1);
    expect(result.stats.successRate).toBe(1);
    expect(result.stats.averageReward).toBe(1);
    expect(result.stats.averageTokens).toBe(15);
  });
});

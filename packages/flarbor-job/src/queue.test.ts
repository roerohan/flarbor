import { describe, expect, it } from "vitest";
import { runQueue } from "./queue.js";
import type { TrialConfig } from "./types.js";

function trial(id: string): TrialConfig {
  return {
    id,
    jobId: "job-1",
    taskId: `task-${id}`,
    agentId: "agent-1",
    attempt: 1,
    task: {
      repoUrl: `https://github.com/example/${id}`,
      instructions: "fix it",
    },
  };
}

describe("runQueue", () => {
  it("respects the configured concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    const records = await runQueue([trial("a"), trial("b"), trial("c"), trial("d")], {
      concurrency: 2,
      runTrial: async (config) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;

        return {
          config,
          status: "succeeded",
          tries: 1,
        };
      },
    });

    expect(records).toHaveLength(4);
    expect(maxActive).toBe(2);
    expect(records.map((record) => record.config.id)).toEqual(["a", "b", "c", "d"]);
  });
});

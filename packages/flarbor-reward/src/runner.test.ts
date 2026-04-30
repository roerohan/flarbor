import { describe, expect, it } from "vitest";
import { criterion } from "./criterion.js";
import { reward } from "./reward.js";
import { run } from "./runner.js";
import type { CriterionContext, WorkspaceLike } from "./types.js";

function workspace(): WorkspaceLike {
  return {
    async readFile() {
      return null;
    },
    async readDir() {
      return [];
    },
  };
}

function context(): CriterionContext {
  return { workspace: workspace(), filesChanged: [], success: true };
}

describe("run", () => {
  it("returns an empty summary when there are no rewards", async () => {
    await expect(run([], context())).resolves.toEqual({
      score: 0,
      rewards: [],
      totalCriteria: 0,
      errors: 0,
    });
  });

  it("averages reward scores and summarizes criteria and errors", async () => {
    const result = await run(
      [
        reward({
          name: "first",
          criteria: [
            criterion({ name: "pass", evaluate: () => true }),
            criterion({ name: "half", evaluate: () => 0.5 }),
          ],
        }),
        reward({
          name: "second",
          criteria: [
            criterion({
              name: "fail",
              evaluate: () => {
                throw new Error("criterion failed");
              },
            }),
          ],
        }),
      ],
      context(),
    );

    expect(result.score).toBe(0.375);
    expect(result.totalCriteria).toBe(3);
    expect(result.errors).toBe(1);
    expect(result.rewards.map((r) => r.name)).toEqual(["first", "second"]);
  });
});

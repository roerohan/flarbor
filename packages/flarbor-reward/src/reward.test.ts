import { describe, expect, it } from "vitest";
import { criterion } from "./criterion.js";
import { evaluateReward, reward } from "./reward.js";
import { mockContext } from "flarbor-shared/testing";

describe("reward", () => {
  it("preserves metadata and defaults aggregation to weighted_mean", () => {
    const criteria = [criterion({ name: "ok", evaluate: () => true })];
    const r = reward({ name: "quality", description: "Quality score", criteria });

    expect(r).toEqual({
      name: "quality",
      description: "Quality score",
      criteria,
      aggregation: "weighted_mean",
    });
  });

  it("evaluates weighted_mean using criterion weights and boolean coercion", async () => {
    const r = reward({
      name: "weighted",
      criteria: [
        criterion({ name: "low", weight: 1, evaluate: () => 0.25 }),
        criterion({ name: "high", weight: 3, evaluate: () => true }),
      ],
    });

    const result = await evaluateReward(r, mockContext());

    expect(result.score).toBe(0.8125);
    expect(result.criteria).toEqual([
      { name: "low", score: 0.25, weight: 1 },
      { name: "high", score: 1, weight: 3 },
    ]);
    expect(result.aggregation).toBe("weighted_mean");
  });

  it("returns zero for empty criteria and zero total weight", async () => {
    await expect(
      evaluateReward(reward({ name: "empty", criteria: [] }), mockContext()),
    ).resolves.toMatchObject({ score: 0, criteria: [] });

    const zeroWeight = reward({
      name: "zero-weight",
      criteria: [criterion({ name: "ignored", weight: 0, evaluate: () => 1 })],
    });

    await expect(evaluateReward(zeroWeight, mockContext())).resolves.toMatchObject({ score: 0 });
  });

  it("supports all aggregation strategies", async () => {
    const criteria = [
      criterion({ name: "zero", evaluate: () => 0 }),
      criterion({ name: "partial", evaluate: () => 0.4 }),
      criterion({ name: "full", evaluate: () => 1 }),
    ];

    await expect(
      evaluateReward(reward({ name: "all", aggregation: "all_pass", criteria }), mockContext()),
    ).resolves.toMatchObject({ score: 0 });
    await expect(
      evaluateReward(reward({ name: "any", aggregation: "any_pass", criteria }), mockContext()),
    ).resolves.toMatchObject({ score: 1 });
    await expect(
      evaluateReward(reward({ name: "min", aggregation: "min", criteria }), mockContext()),
    ).resolves.toMatchObject({ score: 0 });
    await expect(
      evaluateReward(reward({ name: "max", aggregation: "max", criteria }), mockContext()),
    ).resolves.toMatchObject({ score: 1 });
  });

  it("clamps criterion scores before aggregation", async () => {
    const r = reward({
      name: "clamped",
      criteria: [
        criterion({ name: "too-low", evaluate: () => -10 }),
        criterion({ name: "too-high", evaluate: () => 10 }),
      ],
    });

    const result = await evaluateReward(r, mockContext());

    expect(result.score).toBe(0.5);
    expect(result.criteria).toEqual([
      { name: "too-low", score: 0, weight: 1 },
      { name: "too-high", score: 1, weight: 1 },
    ]);
  });

  it("catches criterion errors and records a zero score", async () => {
    const r = reward({
      name: "errors",
      aggregation: "max",
      criteria: [
        criterion({
          name: "throws-error",
          weight: 2,
          evaluate: () => {
            throw new Error("boom");
          },
        }),
        criterion({
          name: "throws-string",
          evaluate: () => {
            throw "bad";
          },
        }),
      ],
    });

    const result = await evaluateReward(r, mockContext());

    expect(result.score).toBe(0);
    expect(result.criteria).toEqual([
      { name: "throws-error", score: 0, weight: 2, error: "boom" },
      { name: "throws-string", score: 0, weight: 1, error: "bad" },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { parseRewardJson, parseRewardText, rewards, toRewardResult } from "./rewards.js";

describe("rewards", () => {
  it("normalizes boolean and numeric scores", () => {
    expect(rewards({ ok: true, exact: 0.5, fail: false })).toEqual({
      rewards: { ok: 1, exact: 0.5, fail: 0 },
    });
  });

  it("parses Harbor reward.txt", () => {
    expect(parseRewardText("0.75\n")).toEqual({ reward: 0.75 });
  });

  it("parses flat Harbor reward.json", () => {
    expect(parseRewardJson('{"unit":1,"docs":0.25}')).toEqual({ unit: 1, docs: 0.25 });
  });

  it("rejects invalid reward values", () => {
    expect(() => parseRewardJson('{"nested":{"bad":1}}')).toThrow("must be a finite number");
    expect(() => parseRewardText("not-a-number")).toThrow("single finite number");
  });

  it("adapts verify results to reward result shape", () => {
    expect(
      toRewardResult({
        kind: "verified",
        rewards: { a: 1, b: 0 },
        logs: { stdout: "", stderr: "", outputTruncated: false },
        artifacts: [],
        durationMs: 1,
        mode: "native",
      }),
    ).toMatchObject({ score: 0.5, totalCriteria: 2, errors: 0 });
  });
});

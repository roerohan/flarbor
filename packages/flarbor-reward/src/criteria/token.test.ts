import { describe, expect, it } from "vitest";
import { tokenBudget, tokenEfficiency, trialSuccess } from "./token.js";
import type { CriterionContext, TokenUsage, WorkspaceLike } from "../types.js";

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

function usage(totalTokens: number, outputTokens: number): TokenUsage {
  return { inputTokens: totalTokens - outputTokens, outputTokens, totalTokens };
}

function context(overrides: Partial<CriterionContext> = {}): CriterionContext {
  return { workspace: workspace(), filesChanged: [], success: true, ...overrides };
}

describe("token criteria", () => {
  it("scores token budgets with missing usage and decay", async () => {
    await expect(tokenBudget(100).evaluate(context())).resolves.toBe(1);
    await expect(tokenBudget(100).evaluate(context({ usage: usage(100, 25) }))).resolves.toBe(1);
    await expect(tokenBudget(100).evaluate(context({ usage: usage(150, 25) }))).resolves.toBe(0.5);
    await expect(tokenBudget(100).evaluate(context({ usage: usage(200, 25) }))).resolves.toBe(0);
    await expect(tokenBudget(0).evaluate(context({ usage: usage(1, 1) }))).resolves.toBe(0);
  });

  it("scores token efficiency from output-to-total ratio", async () => {
    await expect(tokenEfficiency().evaluate(context())).resolves.toBe(0.5);
    await expect(tokenEfficiency().evaluate(context({ usage: usage(0, 0) }))).resolves.toBe(0.5);
    await expect(tokenEfficiency().evaluate(context({ usage: usage(100, 25) }))).resolves.toBe(
      0.25,
    );
  });

  it("reflects trial success", async () => {
    await expect(trialSuccess().evaluate(context({ success: true }))).resolves.toBe(true);
    await expect(trialSuccess().evaluate(context({ success: false }))).resolves.toBe(false);
  });
});

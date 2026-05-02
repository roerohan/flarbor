import { describe, expect, it } from "vitest";
import { tokenBudget, tokenEfficiency, trialSuccess } from "./token.js";
import type { TokenUsage } from "flarbor-shared";
import { mockContext } from "flarbor-shared/testing";

function usage(totalTokens: number, outputTokens: number): TokenUsage {
  return { inputTokens: totalTokens - outputTokens, outputTokens, totalTokens };
}

describe("token criteria", () => {
  it("scores token budgets with missing usage and decay", async () => {
    await expect(tokenBudget(100).evaluate(mockContext())).resolves.toBe(1);
    await expect(tokenBudget(100).evaluate(mockContext({ usage: usage(100, 25) }))).resolves.toBe(1);
    await expect(tokenBudget(100).evaluate(mockContext({ usage: usage(150, 25) }))).resolves.toBe(0.5);
    await expect(tokenBudget(100).evaluate(mockContext({ usage: usage(200, 25) }))).resolves.toBe(0);
    await expect(tokenBudget(0).evaluate(mockContext({ usage: usage(1, 1) }))).resolves.toBe(0);
  });

  it("scores token efficiency from output-to-total ratio", async () => {
    await expect(tokenEfficiency().evaluate(mockContext())).resolves.toBe(0.5);
    await expect(tokenEfficiency().evaluate(mockContext({ usage: usage(0, 0) }))).resolves.toBe(0.5);
    await expect(tokenEfficiency().evaluate(mockContext({ usage: usage(100, 25) }))).resolves.toBe(
      0.25,
    );
  });

  it("reflects trial success", async () => {
    await expect(trialSuccess().evaluate(mockContext({ success: true }))).resolves.toBe(true);
    await expect(trialSuccess().evaluate(mockContext({ success: false }))).resolves.toBe(false);
  });
});

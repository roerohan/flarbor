import { describe, expect, it } from "vitest";
import { didNotTouch, minFilesChanged, stepBudget, touchedFile } from "./trajectory.js";
import { mockContext } from "flarbor-shared/testing";

describe("trajectory criteria", () => {
  it("scores step budgets with defaults, context budget, explicit budget, and decay", async () => {
    await expect(stepBudget().evaluate(mockContext())).resolves.toBe(1);
    await expect(stepBudget().evaluate(mockContext({ steps: 5 }))).resolves.toBe(1);
    await expect(stepBudget().evaluate(mockContext({ steps: 5, maxSteps: 5 }))).resolves.toBe(1);
    await expect(stepBudget(10).evaluate(mockContext({ steps: 6, maxSteps: 5 }))).resolves.toBe(1);
    await expect(stepBudget(10).evaluate(mockContext({ steps: 15 }))).resolves.toBe(0.5);
    await expect(stepBudget(10).evaluate(mockContext({ steps: 20 }))).resolves.toBe(0);
    await expect(stepBudget(0).evaluate(mockContext({ steps: 1 }))).resolves.toBe(0);
    // Zero budget with zero usage: "zero budget = zero tolerance"
    await expect(stepBudget(0).evaluate(mockContext({ steps: 0 }))).resolves.toBe(0);
  });

  it("checks touched and untouched files", async () => {
    const ctx = mockContext({ filesChanged: ["src/a.ts", "README.md"] });

    await expect(touchedFile("src/a.ts").evaluate(ctx)).resolves.toBe(true);
    await expect(touchedFile("src/b.ts").evaluate(ctx)).resolves.toBe(false);
    await expect(didNotTouch("src/b.ts").evaluate(ctx)).resolves.toBe(true);
    await expect(didNotTouch("src/a.ts").evaluate(ctx)).resolves.toBe(false);
  });

  it("checks minimum files changed", async () => {
    const ctx = mockContext({ filesChanged: ["a", "b"] });

    await expect(minFilesChanged(0).evaluate(ctx)).resolves.toBe(true);
    await expect(minFilesChanged(2).evaluate(ctx)).resolves.toBe(true);
    await expect(minFilesChanged(3).evaluate(ctx)).resolves.toBe(false);
  });
});

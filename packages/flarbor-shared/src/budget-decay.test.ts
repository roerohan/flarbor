import { describe, expect, it } from "vitest";

import { budgetDecay } from "./budget-decay.js";

describe("budgetDecay", () => {
  it("returns 1.0 when usage is at or below budget", () => {
    expect(budgetDecay(50, 100)).toBe(1.0);
    expect(budgetDecay(100, 100)).toBe(1.0);
    expect(budgetDecay(0, 100)).toBe(1.0);
  });

  it("returns 0.0 when usage is at or above 2x budget", () => {
    expect(budgetDecay(200, 100)).toBe(0.0);
    expect(budgetDecay(300, 100)).toBe(0.0);
  });

  it("linearly decays between budget and 2x budget", () => {
    expect(budgetDecay(150, 100)).toBeCloseTo(0.5);
    expect(budgetDecay(125, 100)).toBeCloseTo(0.75);
    expect(budgetDecay(175, 100)).toBeCloseTo(0.25);
  });

  it("returns 0 for zero or negative budget, even when usage is zero", () => {
    expect(budgetDecay(10, 0)).toBe(0);
    expect(budgetDecay(0, 0)).toBe(0);
    expect(budgetDecay(10, -5)).toBe(0);
    expect(budgetDecay(0, -5)).toBe(0);
  });
});

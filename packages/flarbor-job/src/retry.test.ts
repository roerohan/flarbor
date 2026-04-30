import { describe, expect, it } from "vitest";
import { retryDelayMs, shouldRetry, withRetry } from "./retry.js";

describe("retryDelayMs", () => {
  it("applies exponential backoff with a cap", () => {
    expect(retryDelayMs(1, { minDelayMs: 10, maxDelayMs: 50, multiplier: 3 })).toBe(10);
    expect(retryDelayMs(2, { minDelayMs: 10, maxDelayMs: 50, multiplier: 3 })).toBe(30);
    expect(retryDelayMs(3, { minDelayMs: 10, maxDelayMs: 50, multiplier: 3 })).toBe(50);
  });
});

describe("shouldRetry", () => {
  it("honors maxRetries", async () => {
    await expect(shouldRetry(new Error("boom"), 1, { maxRetries: 1 })).resolves.toBe(true);
    await expect(shouldRetry(new Error("boom"), 2, { maxRetries: 1 })).resolves.toBe(false);
  });

  it("honors retryOn", async () => {
    await expect(
      shouldRetry(new Error("boom"), 1, { maxRetries: 1, retryOn: () => false }),
    ).resolves.toBe(false);
  });
});

describe("withRetry", () => {
  it("retries throwing operations", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("temporary");
        return "ok";
      },
      { maxRetries: 1, minDelayMs: 0 },
    );

    expect(result).toEqual({ value: "ok", tries: 2 });
  });
});

import { describe, expect, it } from "vitest";

import { truncateText } from "./output.js";

describe("truncateText", () => {
  it("leaves text unchanged when it fits within the byte budget", () => {
    expect(truncateText("hello", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("returns an empty truncated result for non-positive byte budgets", () => {
    expect(truncateText("hello", 0)).toEqual({ text: "", truncated: true });
    expect(truncateText("", 0)).toEqual({ text: "", truncated: false });
  });

  it("appends a marker when truncating output", () => {
    const result = truncateText("abcdef".repeat(20), 60);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("abc");
    expect(result.text).toContain("[flarbor-container: output truncated to 60 bytes]");
  });

  it("truncates oversized markers to the requested byte limit", () => {
    const result = truncateText("abcdef".repeat(20), 8);

    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(8);
  });

  it("does not emit replacement characters when the byte limit cuts a multibyte character", () => {
    const text = "abc😊" + "x".repeat(100);
    const maxBytes = byteLimitWithPayloadBudget(6);
    const result = truncateText(text, maxBytes);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("abc");
    expect(result.text).not.toContain("�");
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(maxBytes);
  });
});

function byteLimitWithPayloadBudget(payloadBytes: number): number {
  for (let maxBytes = 1; maxBytes < 200; maxBytes++) {
    const marker = `\n[flarbor-container: output truncated to ${maxBytes} bytes]\n`;
    if (maxBytes - new TextEncoder().encode(marker).byteLength === payloadBytes) {
      return maxBytes;
    }
  }

  throw new Error(`Could not find truncation limit for ${payloadBytes} payload bytes`);
}

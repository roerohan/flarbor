import { describe, expect, it } from "vitest";

import {
  clampTimeout,
  DEFAULT_ALLOWED_COMMANDS,
  isAllowedCommand,
  validateCommand,
} from "./commands.js";
import { ContainerCommandError, type CommandPattern } from "./types.js";

describe("isAllowedCommand", () => {
  it("accepts default package-manager build and test commands", () => {
    expect(isAllowedCommand("npm test", DEFAULT_ALLOWED_COMMANDS)).toBe(true);
    expect(isAllowedCommand("npm run build -- --mode production", DEFAULT_ALLOWED_COMMANDS)).toBe(
      true,
    );
    expect(isAllowedCommand("pnpm build -- --filter app", DEFAULT_ALLOWED_COMMANDS)).toBe(true);
    expect(isAllowedCommand("yarn test -- --watch=false", DEFAULT_ALLOWED_COMMANDS)).toBe(true);
    expect(isAllowedCommand("bun run build", DEFAULT_ALLOWED_COMMANDS)).toBe(true);
  });

  it("supports string, regex, and function allowlist entries", () => {
    const allowed: readonly CommandPattern[] = [
      "npm test",
      /^pnpm exec tsc$/,
      (command) => command === "custom verify",
    ];

    expect(isAllowedCommand("npm test", allowed)).toBe(true);
    expect(isAllowedCommand("pnpm exec tsc", allowed)).toBe(true);
    expect(isAllowedCommand("custom verify", allowed)).toBe(true);
    expect(isAllowedCommand("custom verify --extra", allowed)).toBe(false);
  });
});

describe("validateCommand", () => {
  it("rejects empty commands", () => {
    expect(() => validateCommand("", DEFAULT_ALLOWED_COMMANDS)).toThrow(ContainerCommandError);
    expect(() => validateCommand("   ", DEFAULT_ALLOWED_COMMANDS)).toThrow(/empty/);
  });

  it("rejects whitespace and control characters", () => {
    expect(() => validateCommand(" npm test", DEFAULT_ALLOWED_COMMANDS)).toThrow(/whitespace/);
    expect(() => validateCommand("npm test\n", DEFAULT_ALLOWED_COMMANDS)).toThrow(/control/);
    expect(() => validateCommand("npm test\0", DEFAULT_ALLOWED_COMMANDS)).toThrow(/control/);
  });

  it("rejects shell control syntax before allowlist matching", () => {
    expect(() => validateCommand("npm test; rm -rf .", DEFAULT_ALLOWED_COMMANDS)).toThrow(
      /shell control syntax/,
    );
    expect(() => validateCommand("npm test $(whoami)", DEFAULT_ALLOWED_COMMANDS)).toThrow(
      /shell control syntax/,
    );
    expect(() => validateCommand("npm test | tee log", DEFAULT_ALLOWED_COMMANDS)).toThrow(
      /shell control syntax/,
    );
  });

  it("rejects commands outside the allowlist with a specific code", () => {
    try {
      validateCommand("npm install", DEFAULT_ALLOWED_COMMANDS);
      throw new Error("Expected command validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerCommandError);
      expect(error).toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    }
  });
});

describe("clampTimeout", () => {
  it("uses the default timeout when none is requested", () => {
    expect(clampTimeout(undefined, 1_000, 5_000)).toBe(1_000);
  });

  it("caps requested timeouts to the configured maximum", () => {
    expect(clampTimeout(10_000, 1_000, 5_000)).toBe(5_000);
    expect(clampTimeout(2_500, 1_000, 5_000)).toBe(2_500);
  });

  it("rejects non-positive and fractional timeouts", () => {
    expect(() => clampTimeout(0, 1_000, 5_000)).toThrow(/positive integer/);
    expect(() => clampTimeout(-1, 1_000, 5_000)).toThrow(/positive integer/);
    expect(() => clampTimeout(1.5, 1_000, 5_000)).toThrow(/positive integer/);
  });
});

import { ContainerCommandError, type CommandPattern } from "./types.js";

export const DEFAULT_ALLOWED_COMMANDS: readonly CommandPattern[] = [
  /^npm (run )?(build|test)( -- .*)?$/,
  /^npm run (build|test)( -- .*)?$/,
  /^pnpm (run )?(build|test)( -- .*)?$/,
  /^pnpm (build|test)( -- .*)?$/,
  /^yarn (build|test)( -- .*)?$/,
  /^bun (run )?(build|test)( -- .*)?$/,
];

export function validateCommand(command: string, allowedCommands: readonly CommandPattern[]): void {
  const trimmed = command.trim();

  if (trimmed.length === 0) {
    throw new ContainerCommandError(
      "INVALID_COMMAND",
      "Container command was empty. Provide a build or test command such as `npm test`.",
    );
  }

  if (trimmed !== command || /[\r\n\0]/.test(command)) {
    throw new ContainerCommandError(
      "INVALID_COMMAND",
      "Container command contains leading/trailing whitespace or control characters. Pass a single command line.",
    );
  }

  if (/[;&|`<>]/.test(command) || command.includes("$(")) {
    throw new ContainerCommandError(
      "INVALID_COMMAND",
      "Container command contains shell control syntax. Pass one allowlisted command and use `env` for environment variables.",
    );
  }

  if (!isAllowedCommand(command, allowedCommands)) {
    throw new ContainerCommandError(
      "COMMAND_NOT_ALLOWED",
      `Container command is not allowlisted: ${command}`,
    );
  }
}

export function isAllowedCommand(
  command: string,
  allowedCommands: readonly CommandPattern[],
): boolean {
  return allowedCommands.some((pattern) => {
    if (typeof pattern === "string") return command === pattern;
    if (pattern instanceof RegExp) return pattern.test(command);
    return pattern(command);
  });
}

export function clampTimeout(
  requested: number | undefined,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): number {
  if (requested === undefined) return defaultTimeoutMs;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new ContainerCommandError(
      "INVALID_COMMAND",
      `Container command timeout must be a positive integer in milliseconds, got ${requested}.`,
    );
  }
  return Math.min(requested, maxTimeoutMs);
}

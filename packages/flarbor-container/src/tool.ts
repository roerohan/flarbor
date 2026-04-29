import { jsonSchema, tool, type JSONSchema7, type Tool } from "ai";

import { ContainerRunner } from "./runner.js";
import type {
  ContainerCommandRequest,
  ContainerCommandResult,
  ContainerRunnerConfig,
} from "./types.js";

const inputJsonSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      description:
        "Allowlisted build or test command to run, for example `npm test` or `npm run build`.",
    },
    cwd: {
      type: "string",
      description:
        "Relative working directory inside the repository. Defaults to the repository root.",
    },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Non-secret environment variables for the command.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description:
        "Command timeout in milliseconds. The runner caps this to its configured maximum.",
    },
    include: {
      type: "array",
      items: { type: "string" },
      description: "Optional workspace glob patterns to sync into the container.",
    },
    exclude: {
      type: "array",
      items: { type: "string" },
      description: "Optional workspace glob patterns to exclude from container sync.",
    },
    captureFiles: {
      type: "array",
      items: { type: "string" },
      description: "Optional relative files to read back from the container after the command.",
    },
  },
  required: ["command"],
};

export function createContainerCommandTool(
  config: ContainerRunnerConfig,
): Tool<ContainerCommandRequest, ContainerCommandResult> {
  const runner = new ContainerRunner(config);

  return tool({
    description:
      "Run heavyweight repository verification commands in a Cloudflare Sandbox container. Use this for build, test, compiler, or package-manager commands that need OS tooling and cannot run inside the Durable Object.",
    inputSchema: jsonSchema<ContainerCommandRequest>(inputJsonSchema, {
      validate: validateRequest,
    }),
    execute: (input) => runner.run(input),
  });
}

function validateRequest(value: unknown) {
  const result = parseRequest(value);
  if (typeof result === "string") return { success: false as const, error: new Error(result) };
  return { success: true as const, value: result };
}

function parseRequest(value: unknown): ContainerCommandRequest | string {
  if (value === null || typeof value !== "object") return "Input must be an object.";
  const command = Reflect.get(value, "command");
  if (typeof command !== "string") return "Input field `command` must be a string.";

  const cwd = Reflect.get(value, "cwd");
  if (cwd !== undefined && typeof cwd !== "string") return "Input field `cwd` must be a string.";

  const timeoutMs = Reflect.get(value, "timeoutMs");
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    return "Input field `timeoutMs` must be a positive integer.";
  }

  const env = Reflect.get(value, "env");
  const parsedEnv = parseStringRecord(env);
  if (env !== undefined && parsedEnv === null)
    return "Input field `env` must map strings to strings.";

  const include = Reflect.get(value, "include");
  const parsedInclude = parseStringArray(include);
  if (include !== undefined && parsedInclude === null)
    return "Input field `include` must be an array of strings.";

  const exclude = Reflect.get(value, "exclude");
  const parsedExclude = parseStringArray(exclude);
  if (exclude !== undefined && parsedExclude === null)
    return "Input field `exclude` must be an array of strings.";

  const captureFiles = Reflect.get(value, "captureFiles");
  const parsedCaptureFiles = parseStringArray(captureFiles);
  if (captureFiles !== undefined && parsedCaptureFiles === null)
    return "Input field `captureFiles` must be an array of strings.";

  return {
    command,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined && typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(env !== undefined && parsedEnv ? { env: parsedEnv } : {}),
    ...(include !== undefined && parsedInclude ? { include: parsedInclude } : {}),
    ...(exclude !== undefined && parsedExclude ? { exclude: parsedExclude } : {}),
    ...(captureFiles !== undefined && parsedCaptureFiles
      ? { captureFiles: parsedCaptureFiles }
      : {}),
  };
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    record[key] = entry;
  }
  return record;
}

function parseStringArray(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    strings.push(entry);
  }
  return strings;
}

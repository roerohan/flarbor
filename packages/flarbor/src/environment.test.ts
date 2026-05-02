import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";

import { FlarborEnvironment } from "./environment.js";
import type { TokenUsage } from "flarbor-shared";
import type { EnvironmentConfig, FlarborEnv } from "./types.js";

const executeTool = { name: "execute" };

vi.mock("@cloudflare/think", () => {
  class MockThink {
    readonly ctx: unknown;
    readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  class MockWorkspace {
    readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
    }
  }

  return { Think: MockThink, Workspace: MockWorkspace };
});

vi.mock("@cloudflare/think/tools/execute", () => ({
  createExecuteTool: vi.fn(() => executeTool),
}));

vi.mock("@cloudflare/think/tools/workspace", () => ({
  createWorkspaceTools: vi.fn((workspace: unknown) => ({ workspace })),
}));

const model = { modelId: "test-model", provider: "test" } as EnvironmentConfig["model"];
const loader = { load: vi.fn() } as FlarborEnv["LOADER"];
const ctx = {
  id: { toString: () => "agent-id" },
  storage: { sql: { exec: () => [], run: () => undefined } },
} as DurableObjectState;

class TestEnvironment extends FlarborEnvironment<FlarborEnv> {
  constructor(private readonly config: EnvironmentConfig) {
    super(ctx, { LOADER: loader });
  }

  getEnvironmentConfig(): EnvironmentConfig {
    return this.config;
  }

  readTokenUsage(): TokenUsage {
    return this.tokenUsage;
  }

  readTurnError(): string | null {
    return this.turnError;
  }

  readTurnCompleted(): boolean {
    return this.turnCompleted;
  }

  reset(): void {
    this.resetTaskState();
  }
}

function config(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    model,
    systemPrompt: "You are testing.",
    ...overrides,
  };
}

describe("FlarborEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns configured model, prompt, tools, and execute tool when enabled", () => {
    const customTool = { description: "custom" };
    const env = new TestEnvironment(config({ tools: { custom: customTool } }));

    expect(env.getModel()).toBe(model);
    expect(env.getSystemPrompt()).toBe("You are testing.");
    expect(env.getTools()).toEqual({ custom: customTool, execute: executeTool });
    expect(createWorkspaceTools).toHaveBeenCalledWith(env.workspace);
    expect(createExecuteTool).toHaveBeenCalledWith({ tools: { workspace: env.workspace }, loader });
  });

  it("does not add the execute tool when code execution is disabled", () => {
    const customTool = { description: "custom" };
    const env = new TestEnvironment(
      config({ enableCodeExecution: false, tools: { custom: customTool } }),
    );

    expect(env.getTools()).toEqual({ custom: customTool });
    expect(createExecuteTool).not.toHaveBeenCalled();
  });

  it("blocks writes, edits, and deletes to protected paths", () => {
    const env = new TestEnvironment(config({ protectedPaths: [".env", "secrets/**"] }));

    expect(env.beforeToolCall({ toolName: "write", input: { path: ".env" } })).toEqual({
      action: "block",
      reason: 'Path ".env" is protected and cannot be modified.',
    });
    expect(
      env.beforeToolCall({ toolName: "edit", input: { filepath: "secrets/prod.json" } }),
    ).toEqual({
      action: "block",
      reason: 'Path "secrets/prod.json" is protected and cannot be modified.',
    });
    expect(env.beforeToolCall({ toolName: "read", input: { path: ".env" } })).toBeUndefined();
    expect(
      env.beforeToolCall({ toolName: "write", input: { path: "src/index.ts" } }),
    ).toBeUndefined();
  });

  it("accumulates token usage across steps and resets task state", () => {
    const env = new TestEnvironment(config());

    env.onStepFinish({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      toolCalls: [{ toolName: "read" }],
    });
    env.onStepFinish({
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      toolCalls: [],
    });

    expect(env.readTokenUsage()).toEqual({ inputTokens: 15, outputTokens: 10, totalTokens: 25 });

    env.reset();

    expect(env.readTokenUsage()).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(env.readTurnError()).toBeNull();
    expect(env.readTurnCompleted()).toBe(false);
  });

  it("records chat response errors and aborted turns", () => {
    const env = new TestEnvironment(config());

    env.onChatResponse({ status: "error", error: "model failed" });
    expect(env.readTurnError()).toBe("model failed");
    expect(env.readTurnCompleted()).toBe(true);

    env.reset();
    env.onChatResponse({ status: "aborted" });
    expect(env.readTurnError()).toBe("Turn was aborted");
    expect(env.readTurnCompleted()).toBe(true);
  });

  it("returns chat errors after recording their message", () => {
    const env = new TestEnvironment(config());
    const error = new Error("provider unavailable");

    expect(env.onChatError(error)).toBe(error);
    expect(env.readTurnError()).toBe("provider unavailable");
  });

  it("suppresses the known Agent name hydration race and rethrows other errors", () => {
    const env = new TestEnvironment(config());
    const error = new Error("other failure");

    expect(() => env.onError(new Error("Attempting to read .name before hydration"))).not.toThrow();
    expect(() => env.onError(error)).toThrow(error);
  });
});

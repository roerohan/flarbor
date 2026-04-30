import { describe, expect, it, vi } from "vitest";

import { createContainerCommandTool } from "./tool.js";
import { ContainerCommandError, type ContainerRunnerConfig, type WorkspaceLike } from "./types.js";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

describe("createContainerCommandTool", () => {
  it("creates an AI SDK tool without executing the runner", () => {
    const tool = createContainerCommandTool({
      sandbox: makeDurableObjectNamespace(),
      workspace,
      sandboxId: "tool-smoke-test",
    });

    expect(tool).toBeTypeOf("object");
  });
});

const workspace: WorkspaceLike = {
  async readFile() {
    return null;
  },
  async readDir() {
    return [];
  },
};

function makeDurableObjectNamespace(): ContainerRunnerConfig["sandbox"] {
  const id = {
    toString() {
      return "durable-object-id";
    },
    equals() {
      return false;
    },
  };
  const namespace: ContainerRunnerConfig["sandbox"] = {
    newUniqueId() {
      return id;
    },
    idFromName() {
      return id;
    },
    idFromString() {
      return id;
    },
    get(): never {
      throw new ContainerCommandError("SANDBOX_ERROR", "Unexpected Durable Object get in test");
    },
    getByName(): never {
      throw new ContainerCommandError(
        "SANDBOX_ERROR",
        "Unexpected Durable Object getByName in test",
      );
    },
    jurisdiction() {
      return namespace;
    },
  };
  return namespace;
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { judge } from "./judge.js";
import type { CriterionContext, JudgeConfig, WorkspaceLike } from "./types.js";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}));

const model = "mock-model" as never;

function workspace(files: Record<string, string>): WorkspaceLike {
  return {
    async readFile(path) {
      return Object.hasOwn(files, path) ? files[path] : null;
    },
    async readDir() {
      return Object.keys(files).map((path) => ({ path, type: "file" }));
    },
  };
}

function context(files: Record<string, string>): CriterionContext {
  return { workspace: workspace(files), filesChanged: Object.keys(files), success: true };
}

function config(overrides: Omit<Partial<JudgeConfig>, "model"> = {}): JudgeConfig {
  return {
    model,
    files: ["src/a.ts"],
    prompt: "Does this satisfy the requirement?",
    type: "binary",
    ...overrides,
  };
}

describe("judge", () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
  });

  it("uses default metadata and builds a prompt from existing files only", async () => {
    mocks.generateText.mockResolvedValue({ text: "YES" });
    const c = judge(config({ files: ["src/a.ts", "missing.ts"] }));

    const score = await c.evaluate(context({ "src/a.ts": "export const a = 1;" }));

    expect(score).toBe(1);
    expect(c.name).toBe("judge:binary");
    expect(c.description).toBe("Does this satisfy the requirement?");
    expect(c.weight).toBe(1);
    expect(mocks.generateText).toHaveBeenCalledOnce();
    const call = mocks.generateText.mock.calls[0]?.[0];
    expect(call).toMatchObject({ model });
    expect(call?.prompt).toContain("### src/a.ts\n```\nexport const a = 1;\n```");
    expect(call?.prompt).not.toContain("missing.ts");
    expect(call?.prompt).toContain("Answer with exactly YES or NO. Nothing else.");
  });

  it("returns zero without calling the model when all files are missing", async () => {
    const c = judge(config({ files: ["missing.ts"] }));

    await expect(c.evaluate(context({}))).resolves.toBe(0);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("supports custom name and weight", () => {
    const c = judge(config(), { name: "custom-judge", weight: 4 });

    expect(c.name).toBe("custom-judge");
    expect(c.weight).toBe(4);
  });

  it("parses binary responses", async () => {
    const c = judge(config());

    mocks.generateText.mockResolvedValueOnce({ text: "No" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(0);

    mocks.generateText.mockResolvedValueOnce({ text: "This is correct" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(1);

    mocks.generateText.mockResolvedValueOnce({ text: "unclear" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(0);
  });

  it("parses and clamps likert responses", async () => {
    const c = judge(config({ type: "likert", points: 5 }));

    mocks.generateText.mockResolvedValueOnce({ text: "3" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(0.5);

    mocks.generateText.mockResolvedValueOnce({ text: "9" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(1);

    mocks.generateText.mockResolvedValueOnce({ text: "none" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(0.5);

    const call = mocks.generateText.mock.calls[0]?.[0];
    expect(call?.prompt).toContain("Rate on a scale of 1 to 5. Answer with just the number.");
  });

  it("defaults likert to five points and rejects invalid point counts", async () => {
    mocks.generateText.mockResolvedValue({ text: "5" });
    await expect(
      judge(config({ type: "likert" })).evaluate(context({ "src/a.ts": "code" })),
    ).resolves.toBe(1);

    await expect(
      judge(config({ type: "likert", points: 1 })).evaluate(context({ "src/a.ts": "code" })),
    ).rejects.toThrow("Likert judge requires points >= 2, got 1");
  });

  it("parses and clamps float responses", async () => {
    const c = judge(config({ type: "float" }));

    mocks.generateText.mockResolvedValueOnce({ text: "0.75" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(0.75);

    mocks.generateText.mockResolvedValueOnce({ text: "1.4" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(1);

    mocks.generateText.mockResolvedValueOnce({ text: "no score" });
    await expect(c.evaluate(context({ "src/a.ts": "code" }))).resolves.toBe(0.5);

    const call = mocks.generateText.mock.calls[0]?.[0];
    expect(call?.prompt).toContain(
      "Answer with a single decimal number between 0.0 and 1.0. Nothing else.",
    );
  });
});

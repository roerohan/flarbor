import { generateText } from "ai";
import { criterion } from "./criterion.js";
import type { Criterion, CriterionContext, JudgeConfig } from "./types.js";

function resolveLikertPoints(points: number | undefined): number {
  const resolved = points ?? 5;
  if (!Number.isInteger(resolved) || resolved < 2) {
    throw new Error(`Likert judge requires points >= 2, got ${resolved}`);
  }
  return resolved;
}

function buildJudgePrompt(config: JudgeConfig, fileContents: Map<string, string>): string {
  const filesSection = Array.from(fileContents.entries())
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  const typeInstruction = {
    binary: "Answer with exactly YES or NO. Nothing else.",
    likert: `Rate on a scale of 1 to ${resolveLikertPoints(config.points)}. Answer with just the number.`,
    float: "Answer with a single decimal number between 0.0 and 1.0. Nothing else.",
  }[config.type];

  return [
    "You are evaluating code produced by an AI agent. Review the following files and answer the question.",
    "",
    "## Files",
    filesSection,
    "",
    "## Question",
    config.prompt,
    "",
    "## Instructions",
    typeInstruction,
  ].join("\n");
}

function parseJudgeResponse(response: string, config: JudgeConfig): number {
  const text = response.trim().toLowerCase();

  switch (config.type) {
    case "binary": {
      if (text.startsWith("yes")) return 1.0;
      if (text.startsWith("no")) return 0.0;
      if (text.includes("yes") || text.includes("correct") || text.includes("pass"))
        return 1.0;
      return 0.0;
    }
    case "likert": {
      const points = resolveLikertPoints(config.points);
      const match = text.match(/\d+/);
      if (!match) return 0.5;
      const value = parseInt(match[0], 10);
      return Math.max(0, Math.min(1, (value - 1) / (points - 1)));
    }
    case "float": {
      const match = text.match(/[\d.]+/);
      if (!match) return 0.5;
      const value = parseFloat(match[0]);
      return Math.max(0, Math.min(1, value));
    }
  }
}

/**
 * Create a criterion that uses an LLM as a judge.
 * Reads the specified files from the workspace, builds a prompt,
 * and parses the response into a 0.0-1.0 score.
 */
export function judge(
  config: JudgeConfig,
  opts?: { name?: string; weight?: number },
): Criterion {
  return criterion({
    name: opts?.name ?? `judge:${config.type}`,
    description: config.prompt.slice(0, 80),
    weight: opts?.weight,
    evaluate: async (ctx: CriterionContext) => {
      const fileContents = new Map<string, string>();
      for (const filePath of config.files) {
        const content = await ctx.workspace.readFile(filePath);
        if (content !== null) {
          fileContents.set(filePath, content);
        }
      }

      if (fileContents.size === 0) return 0;

      const prompt = buildJudgePrompt(config, fileContents);
      const result = await generateText({ model: config.model, prompt });
      return parseJudgeResponse(result.text, config);
    },
  });
}

import { generateText } from "ai";
import { criterion } from "./criterion.js";
import type { Criterion, CriterionContext, JudgeConfig } from "./types.js";

/**
 * Build a prompt for the LLM judge.
 */
function buildJudgePrompt(
  config: JudgeConfig,
  fileContents: Map<string, string>,
): string {
  const filesSection = Array.from(fileContents.entries())
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join("\n\n");

  const typeInstruction = {
    binary:
      "Answer with exactly YES or NO. Nothing else.",
    likert:
      `Rate on a scale of 1 to ${config.points ?? 5}. Answer with just the number.`,
    float:
      "Answer with a single decimal number between 0.0 and 1.0. Nothing else.",
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

/**
 * Parse the judge's response into a 0.0-1.0 score.
 */
function parseJudgeResponse(
  response: string,
  config: JudgeConfig,
): number {
  const text = response.trim().toLowerCase();

  switch (config.type) {
    case "binary": {
      if (text.startsWith("yes")) return 1.0;
      if (text.startsWith("no")) return 0.0;
      // Fallback: check for positive/negative signals
      if (text.includes("yes") || text.includes("correct") || text.includes("pass"))
        return 1.0;
      return 0.0;
    }
    case "likert": {
      const points = config.points ?? 5;
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
 *
 * The judge reads the specified files from the workspace and answers
 * the evaluation prompt. The response is parsed into a 0.0-1.0 score
 * based on the configured type (binary, likert, float).
 *
 * @example
 * ```typescript
 * import { createWorkersAI } from "workers-ai-provider";
 *
 * const codeQuality = judge({
 *   model: createWorkersAI({ binding: env.AI })("@cf/moonshotai/kimi-k2.5"),
 *   files: ["src/main.ts"],
 *   prompt: "Is the code well-structured with proper error handling?",
 *   type: "likert",
 *   points: 5,
 * });
 * ```
 *
 * @example Binary judgment
 * ```typescript
 * const isCorrect = judge({
 *   model: myModel,
 *   files: ["output.txt"],
 *   prompt: "Does the output contain a valid JSON array?",
 *   type: "binary",
 * });
 * ```
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
      // Read all requested files
      const fileContents = new Map<string, string>();
      for (const filePattern of config.files) {
        const content = await ctx.workspace.readFile(filePattern);
        if (content !== null) {
          fileContents.set(filePattern, content);
        }
      }

      if (fileContents.size === 0) {
        return 0; // No files found to judge
      }

      const prompt = buildJudgePrompt(config, fileContents);

      const result = await generateText({
        model: config.model,
        prompt,
      });

      return parseJudgeResponse(result.text, config);
    },
  });
}

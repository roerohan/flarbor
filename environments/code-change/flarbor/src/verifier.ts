/**
 * PR-replay verifier.
 *
 * Uses `flarbor-verify` to score the agent's output against a known-good PR.
 * Criteria mix (weights normalised to 1.0):
 *   - tests_pass      0.50  — scoped test command succeeds in sandbox
 *   - file_patterns    0.20  — expected substrings/regexes present in files
 *   - file_touch       0.20  — only expected files modified
 *   - llm_judge        0.10  — semantic diff comparison via LLM
 */

import { generateText, type LanguageModel } from "ai";
import {
  fileContains,
  fileMatches,
  runVerifyCriteria,
  createSandboxExec,
  type VerifyContext,
  type VerifyCriterion,
  type RewardResultLike,
  type SandboxNamespace,
  type WorkspaceLike,
} from "flarbor-verify";
import type { PRReplayTask } from "./tasks.js";

// ---------------------------------------------------------------------------
// Weight constants
// ---------------------------------------------------------------------------

const W_TESTS = 0.5;
const W_PATTERNS = 0.2;
const W_TOUCH = 0.2;
const W_JUDGE = 0.1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifyPRReplayOptions {
  task: PRReplayTask;
  workspace: WorkspaceLike;
  filesChanged: readonly string[];
  success: boolean;
  referenceDiff: string;
  model?: LanguageModel;
  sandbox?: SandboxNamespace;
  sandboxId?: string;
}

interface ScorerResult {
  score: number;
  error?: string;
}

/**
 * Run the full PR-replay verification and return a `RewardResultLike`
 * compatible with the flarbor reward system.
 */
export async function verifyPRReplay(options: VerifyPRReplayOptions): Promise<RewardResultLike> {
  const { task, workspace, filesChanged, referenceDiff, model, sandbox, sandboxId } = options;

  // Fail fast if the reference diff is missing — judging would be meaningless.
  if (!referenceDiff) {
    return {
      score: 0,
      totalCriteria: 1,
      errors: 1,
      rewards: [
        {
          name: `pr-replay:${task.id}`,
          score: 0,
          aggregation: "weighted_mean" as const,
          criteria: [
            {
              name: "missing_reference_diff",
              score: 0,
              weight: 1,
              error: `No reference diff found for patch file "${task.patchFile}"`,
            },
          ],
        },
      ],
    };
  }

  // Build raw scores for each category independently (0.0–1.0 each).
  // Weights are applied when computing the final aggregate below.

  // 1. Tests (50%) — uses sandbox exec if available, otherwise skip gracefully.
  const tests = await scoreTests(task, workspace, sandbox, sandboxId);

  // 2. File pattern checks (20%) — deterministic substring/regex checks.
  const patterns = await scorePatterns(task, workspace);

  // 3. File touch (20%) — penalise touching unexpected files.
  const touch: ScorerResult = { score: scoreFileTouch(task, filesChanged) };

  // 4. LLM judge (10%) — semantic comparison of diffs.
  const judge = model
    ? await scoreLLMJudge(task, workspace, filesChanged, referenceDiff, model)
    : { score: 1.0 }; // If no model provided, give full marks (don't penalise).

  const scorers = [
    { name: "tests_pass", weight: W_TESTS, result: tests },
    { name: "file_patterns", weight: W_PATTERNS, result: patterns },
    { name: "file_touch", weight: W_TOUCH, result: touch },
    { name: "llm_judge", weight: W_JUDGE, result: judge },
  ] as const;

  // Compute the weighted aggregate score.
  const weightedScore = scorers.reduce((sum, s) => sum + s.result.score * s.weight, 0);
  const errorCount = scorers.filter((s) => s.result.error !== undefined).length;

  // Build the RewardResultLike directly with proper weighted criteria.
  // We avoid toRewardResult() because it uses a simple average that
  // doesn't respect our 50/20/20/10 weight distribution.
  return {
    score: weightedScore,
    totalCriteria: scorers.length,
    errors: errorCount,
    rewards: [
      {
        name: `pr-replay:${task.id}`,
        score: weightedScore,
        aggregation: "weighted_mean" as const,
        criteria: scorers.map((s) => ({
          name: s.name,
          score: s.result.score,
          weight: s.weight,
          ...(s.result.error ? { error: s.result.error } : {}),
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Tests
// ---------------------------------------------------------------------------

async function scoreTests(
  task: PRReplayTask,
  workspace: WorkspaceLike,
  sandbox: SandboxNamespace | undefined,
  sandboxId: string | undefined,
): Promise<ScorerResult> {
  if (!sandbox || !sandboxId) return { score: 0, error: "No sandbox available for test execution" };
  if (!task.testCommand) return { score: 0, error: "No test command configured for this task" };

  try {
    const exec = createSandboxExec({
      sandbox,
      sandboxId,
      workspace,
      defaultTimeoutMs: 120_000,
    });

    // Run setup first if specified.
    if (task.setupCommand) {
      const setup = await exec.run({ command: task.setupCommand, timeoutMs: 180_000 });
      if (!setup.success) {
        const msg = `Setup failed: exit=${setup.exitCode} stderr=${setup.stderr.slice(0, 200)}`;
        console.warn(`[verify] ${msg}`);
        return { score: 0, error: msg };
      }
    }

    // Run scoped tests.
    const result = await exec.run({ command: task.testCommand, timeoutMs: 120_000 });
    return { score: result.success ? 1 : 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[verify] test execution error: ${msg}`);
    return { score: 0, error: `Test execution error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// 2. File patterns
// ---------------------------------------------------------------------------

async function scorePatterns(task: PRReplayTask, workspace: WorkspaceLike): Promise<ScorerResult> {
  if (task.expectedPatterns.length === 0) return { score: 1 };

  const criteria: VerifyCriterion[] = task.expectedPatterns.map((pattern, index) =>
    pattern.regex
      ? fileMatches({
          name: `pattern_${index}`,
          path: pattern.path,
          pattern: pattern.contains,
        })
      : fileContains({
          name: `pattern_${index}`,
          path: pattern.path,
          text: pattern.contains,
        }),
  );

  const ctx: VerifyContext = {
    workspace,
    filesChanged: [],
    success: true,
    capabilities: {},
  };

  try {
    const output = await runVerifyCriteria(criteria, ctx);
    const values = Object.values(output.rewards);
    if (values.length === 0) return { score: 1 };
    return { score: values.reduce((sum, v) => sum + v, 0) / values.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { score: 0, error: `Pattern check error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// 3. File touch
// ---------------------------------------------------------------------------

function scoreFileTouch(task: PRReplayTask, filesChanged: readonly string[]): number {
  if (filesChanged.length === 0) return 0;

  const expected = new Set(task.expectedFiles);
  const unexpected = filesChanged.filter((f) => !expected.has(f));

  // Full marks if only expected files were touched.
  // Deduct proportionally for unexpected files.
  if (unexpected.length === 0) return 1;

  const penalty = unexpected.length / filesChanged.length;
  return Math.max(0, 1 - penalty);
}

// ---------------------------------------------------------------------------
// Reference diffs
// ---------------------------------------------------------------------------
// Inlined for Worker deployment (no filesystem access at runtime).
// In production, these would live in R2/KV.

export const REFERENCE_DIFFS: Record<string, string> = {
  "zod-5855.patch": [
    "diff --git a/packages/zod/src/v4/classic/tests/default.test.ts b/packages/zod/src/v4/classic/tests/default.test.ts",
    "index 2fb29ab253..d7ff8b4dba 100644",
    "--- a/packages/zod/src/v4/classic/tests/default.test.ts",
    "+++ b/packages/zod/src/v4/classic/tests/default.test.ts",
    '@@ -332,6 +332,50 @@ test("defaulted array schema returns shallow clone", () => {',
    "   expect(result1).toEqual(result2);",
    " });",
    " ",
    '+test("defaulted Map schema returns shallow clone", () => {',
    "+  const schema = z.map(z.string(), z.number()).default(new Map([[\"a\", 1]]));",
    "+  const result1 = schema.parse(undefined);",
    "+  const result2 = schema.parse(undefined);",
    "+  expect(result1).not.toBe(result2);",
    "+  expect(result1).toEqual(result2);",
    "+});",
    "+",
    '+test("defaulted Set schema returns shallow clone", () => {',
    '+  const schema = z.set(z.string()).default(new Set(["x"]));',
    "+  const result1 = schema.parse(undefined);",
    "+  const result2 = schema.parse(undefined);",
    "+  expect(result1).not.toBe(result2);",
    "+  expect(result1).toEqual(result2);",
    "+});",
    "+",
    '+test("mutations on defaulted Map do not affect subsequent parses", () => {',
    "+  const schema = z.map(z.string(), z.number()).default(new Map());",
    "+  const result1 = schema.parse(undefined);",
    "+  const result2 = schema.parse(undefined);",
    '+  result1.set("key1", 1);',
    '+  result2.set("key2", 2);',
    "+  expect(result1.size).toBe(1);",
    '+  expect(result1.get("key1")).toBe(1);',
    '+  expect(result1.has("key2")).toBe(false);',
    "+  expect(result2.size).toBe(1);",
    '+  expect(result2.get("key2")).toBe(2);',
    '+  expect(result2.has("key1")).toBe(false);',
    "+});",
    "+",
    '+test("mutations on defaulted Set do not affect subsequent parses", () => {',
    "+  const schema = z.set(z.string()).default(new Set());",
    "+  const result1 = schema.parse(undefined);",
    "+  const result2 = schema.parse(undefined);",
    '+  result1.add("item1");',
    '+  result2.add("item2");',
    "+  expect(result1.size).toBe(1);",
    '+  expect(result1.has("item1")).toBe(true);',
    '+  expect(result1.has("item2")).toBe(false);',
    "+  expect(result2.size).toBe(1);",
    '+  expect(result2.has("item2")).toBe(true);',
    '+  expect(result2.has("item1")).toBe(false);',
    "+});",
    "+",
    ' test("direction-aware defaults", () => {',
    '   const schema = z.string().default("hello");',
    " ",
    "diff --git a/packages/zod/src/v4/core/util.ts b/packages/zod/src/v4/core/util.ts",
    "index f7aee1a885..6a5f1a841f 100644",
    "--- a/packages/zod/src/v4/core/util.ts",
    "+++ b/packages/zod/src/v4/core/util.ts",
    "@@ -407,6 +407,8 @@ export function isPlainObject(o: any): o is Record<PropertyKey, unknown> {",
    " export function shallowClone(o: any): any {",
    "   if (isPlainObject(o)) return { ...o };",
    "   if (Array.isArray(o)) return [...o];",
    "+  if (o instanceof Map) return new Map(o);",
    "+  if (o instanceof Set) return new Set(o);",
    "   return o;",
    " }",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// 4. LLM judge
// ---------------------------------------------------------------------------

async function scoreLLMJudge(
  task: PRReplayTask,
  workspace: WorkspaceLike,
  filesChanged: readonly string[],
  referenceDiff: string,
  model: LanguageModel,
): Promise<ScorerResult> {
  try {
    // Read the agent's modified files.
    const agentFiles: string[] = [];
    for (const filePath of filesChanged) {
      const content = await workspace.readFile(filePath);
      if (content !== null) {
        agentFiles.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    const prompt = [
      "You are evaluating whether an AI agent's code changes correctly implement a PR.",
      "",
      `## Task: ${task.name}`,
      "",
      "## Original PR Description (what was requested)",
      task.instructions,
      "",
      "## Reference Diff (the known-good implementation that was merged)",
      "```diff",
      referenceDiff,
      "```",
      "",
      "## Agent's Modified Files",
      agentFiles.join("\n\n"),
      "",
      "## Question",
      "Does the agent's implementation achieve the same behavioral outcome as the reference diff?",
      "It does NOT need to be identical code — just functionally equivalent.",
      "Consider: Does it fix the same bug? Does it handle the same edge cases?",
      "",
      "Rate on a scale of 1 to 5 where:",
      "1 = completely wrong or unrelated changes",
      "2 = partially addresses the issue but misses key cases",
      "3 = addresses the core issue but with notable differences in quality or coverage",
      "4 = functionally equivalent with minor style/approach differences",
      "5 = essentially identical behavior and quality",
      "",
      "Answer with just the number.",
    ].join("\n");

    const result = await generateText({ model, prompt });
    const text = result.text.trim();
    // Match a standalone digit 1-5 (not part of a larger number).
    const match = text.match(/\b([1-5])\b/);
    if (!match) return { score: 0.5, error: `LLM judge returned unparseable response: "${text.slice(0, 100)}"` };
    const value = parseInt(match[1], 10);
    // Normalise 1-5 → 0.0-1.0
    return { score: (value - 1) / 4 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[verify] LLM judge error: ${msg}`);
    return { score: 0.5, error: `LLM judge error: ${msg}` }; // Neutral score on error.
  }
}

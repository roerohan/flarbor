/**
 * Static task suite for PR replay.
 *
 * Each entry captures enough metadata to replay a real-world PR:
 * check out a repo at `baseCommit`, give the agent `instructions`,
 * then verify the result against the known-good diff in `patchFile`.
 */

export interface PRReplayTask {
  /** Unique task ID (e.g. "zod-5855"). */
  readonly id: string;

  /** Human-readable label. */
  readonly name: string;

  /** Repository to clone. */
  readonly repoUrl: string;

  /** Commit SHA to check out before the agent starts. */
  readonly baseCommit: string;

  /** Merge commit SHA (the state after the PR landed). */
  readonly mergeCommit: string;

  /** PR number (for traceability). */
  readonly prNumber: number;

  /** Instructions given to the agent — sourced from the original PR title + body. */
  readonly instructions: string;

  /**
   * Key into `REFERENCE_DIFFS` in verifier.ts (e.g. "zod-5855.patch").
   * The reference diff is inlined for Worker deployment (no filesystem).
   */
  readonly patchFile: string;

  /** Files the PR actually touched (for file-touch verification). */
  readonly expectedFiles: readonly string[];

  /**
   * Setup command to run before tests (e.g. `pnpm install`).
   * Executed inside the sandbox.
   */
  readonly setupCommand?: string;

  /**
   * Scoped test command for verification (e.g. `pnpm vitest run ...`).
   * Executed inside the sandbox.
   */
  readonly testCommand: string;

  /** Patterns to check inside modified files (deterministic content checks). */
  readonly expectedPatterns: readonly FilePattern[];
}

export interface FilePattern {
  /** File path relative to repo root. */
  readonly path: string;
  /** Substring or regex that must be present in the file after the agent's changes. */
  readonly contains: string;
  /** If true, `contains` is treated as a regex pattern. */
  readonly regex?: boolean;
}

// ---------------------------------------------------------------------------
// Task suite
// ---------------------------------------------------------------------------

export const TASKS: readonly PRReplayTask[] = [
  {
    id: "zod-5855",
    name: "zod: clone Map and Set in shallowClone",
    repoUrl: "https://github.com/colinhacks/zod.git",
    baseCommit: "b6b1288277e6ca87dab0ad1c7251b92612b7445c",
    mergeCommit: "34f601590351e5d3a57fe20c001155940ba65324",
    prNumber: 5855,

    instructions: [
      "Fix a bug in Zod v4: when using `.default()` with mutable values like `Map` or `Set`,",
      "every call to `.parse(undefined)` returns the same reference. Mutations on one parse",
      "result leak into subsequent parses.",
      "",
      "Example of the bug:",
      "```ts",
      'const schema = z.map(z.string(), z.number()).default(new Map());',
      "const result1 = schema.parse(undefined);",
      'result1.set("key", 42);',
      "const result2 = schema.parse(undefined);",
      "console.log(result2.size); // 1 — should be 0",
      "```",
      "",
      "This already works correctly for plain objects and arrays via `shallowClone` in",
      "`packages/zod/src/v4/core/util.ts`, but `Map` and `Set` fall through to `return o`",
      "(same reference).",
      "",
      "Fix `shallowClone` to handle `Map` and `Set`, and add tests to",
      "`packages/zod/src/v4/classic/tests/default.test.ts` covering:",
      "- Shallow clone returns distinct instances for Map and Set",
      "- Mutations on one parse result do not affect another (both directions)",
    ].join("\n"),

    patchFile: "zod-5855.patch",

    expectedFiles: [
      "packages/zod/src/v4/core/util.ts",
      "packages/zod/src/v4/classic/tests/default.test.ts",
    ],

    setupCommand: "pnpm install --frozen-lockfile",
    testCommand: "pnpm vitest run packages/zod/src/v4/classic/tests/default.test.ts",

    expectedPatterns: [
      // Implementation: shallowClone must clone Map instances
      {
        path: "packages/zod/src/v4/core/util.ts",
        contains: "instanceof Map) return new Map",
      },
      // Implementation: shallowClone must clone Set instances
      {
        path: "packages/zod/src/v4/core/util.ts",
        contains: "instanceof Set) return new Set",
      },
      // Tests: Map default clone test exists
      {
        path: "packages/zod/src/v4/classic/tests/default.test.ts",
        contains: "defaulted Map",
      },
      // Tests: Set default clone test exists
      {
        path: "packages/zod/src/v4/classic/tests/default.test.ts",
        contains: "defaulted Set",
      },
    ],
  },
];

export function getTask(id: string): PRReplayTask | undefined {
  return TASKS.find((t) => t.id === id);
}

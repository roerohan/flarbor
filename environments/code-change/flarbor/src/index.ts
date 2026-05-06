/**
 * PR-replay environment for code-change evaluation.
 *
 * Flow:
 *   1. Receive a task ID (referencing a static PRReplayTask) via POST /run
 *   2. Clone the repo at the base commit (before the PR)
 *   3. Give the agent the PR description as instructions
 *   4. Agent modifies code
 *   5. Verify using flarbor-verify (tests, file patterns, file touch, LLM judge)
 *   6. Return TrialResult with reward scores
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest } from "agents";
import { z } from "zod";
import { FlarborEnvironment, runTask, agentNameFor } from "flarbor";
import type { EnvironmentConfig, FlarborEnv, TrialResult } from "flarbor";
import type { RewardResult } from "flarbor-shared";
import { TASKS, getTask, type PRReplayTask } from "./tasks.js";
import { verifyPRReplay, REFERENCE_DIFFS } from "./verifier.js";

// ---------------------------------------------------------------------------
// Env bindings
// ---------------------------------------------------------------------------

interface Env extends FlarborEnv {
  FLARBOR_AGENT: DurableObjectNamespace;
  /** Default task ID if not provided in POST body. */
  TASK_ID?: string;
  MAX_STEPS?: string;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const RunRequestSchema = z.object({
  taskId: z.string().min(1),
  branch: z.string().min(1).optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().email().optional(),
  maxSteps: z.number().int().positive().optional(),
});

type RunRequest = z.infer<typeof RunRequestSchema>;

function parseMaxSteps(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["maxSteps"],
        message: `MAX_STEPS must be a positive integer, got "${value}"`,
      },
    ]);
  }
  return parsed;
}

function resolveRunRequest(body: unknown, env: Env): RunRequest {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return RunRequestSchema.parse({
    taskId: raw.taskId ?? env.TASK_ID,
    branch: raw.branch,
    authorName: raw.authorName,
    authorEmail: raw.authorEmail,
    maxSteps: raw.maxSteps ?? parseMaxSteps(env.MAX_STEPS),
  });
}

/**
 * Convert a `RewardResultLike` (from flarbor-verify) to a `RewardResult`
 * (from flarbor-shared). The types are structurally compatible — this
 * function exists so we get a compile error if they ever diverge.
 */
function toReward(result: {
  score: number;
  rewards: Array<{
    name: string;
    score: number;
    criteria: Array<{ name: string; score: number; weight: number; error?: string }>;
    aggregation: "weighted_mean";
  }>;
  totalCriteria: number;
  errors: number;
}): RewardResult {
  return result;
}

// ---------------------------------------------------------------------------
// Task list response (shared by Worker and DO)
// ---------------------------------------------------------------------------

function taskListResponse(): Response {
  return Response.json(
    TASKS.map((t) => ({ id: t.id, name: t.name, repoUrl: t.repoUrl, prNumber: t.prNumber })),
  );
}

// ---------------------------------------------------------------------------
// Agent (Durable Object)
// ---------------------------------------------------------------------------

export class FlarborAgent extends FlarborEnvironment<Env> {
  getEnvironmentConfig(): EnvironmentConfig {
    return {
      model: createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-sonnet-4-20250514"),

      systemPrompt: [
        "You are a code modification agent. You have access to a cloned git repository in your workspace.",
        "A bug has been reported. Your job is to fix it and add tests.",
        "",
        "Use the workspace tools (read, write, edit, find, grep, list) to understand the codebase and make the requested changes.",
        "Use the execute tool to run JavaScript code when you need to process multiple files or do complex operations.",
        "",
        "Guidelines:",
        "- Read the existing code to understand patterns before writing.",
        "- Make minimal, targeted changes — only modify what's needed.",
        "- Add tests that cover the fix.",
        "- Do not modify files unnecessarily.",
        "- When you are done, summarize what you changed and why.",
      ].join("\n"),

      configureSession: (session) =>
        session
          .withContext("plan", {
            description: "Your current plan for completing the task. Update as you progress.",
            maxTokens: 1000,
          })
          .withContext("memory", {
            description:
              "Important facts learned about this codebase. File locations, patterns, conventions.",
            maxTokens: 2000,
          })
          .withCachedPrompt(),

      maxSteps: 30,
      protectedPaths: [".git", ".git/**", ".github/workflows", ".github/workflows/**"],
    };
  }

  async handlePRReplay(req: RunRequest): Promise<TrialResult> {
    const task = getTask(req.taskId);
    if (!task) {
      return {
        success: false,
        branch: "",
        commitSha: "",
        filesChanged: [],
        error: `Unknown task ID: "${req.taskId}". Available: ${TASKS.map((t) => t.id).join(", ")}`,
      };
    }

    const taskStart = Date.now();
    this.resetTaskState();
    this.maxSteps = req.maxSteps ?? 30;

    const branch = req.branch ?? `flarbor/${task.id}-${Date.now().toString(36)}`;
    const token = this.env.GITHUB_TOKEN;

    console.log(
      `[pr-replay] task_start id=${task.id} repo=${task.repoUrl}` +
        ` base=${task.baseCommit.slice(0, 8)} branch=${branch} max_steps=${this.maxSteps}`,
    );

    // --- Clone at base commit ---
    // Full clone (no depth limit) so we can check out the pre-PR commit.
    // Bypasses GitWorkspace.clone() which hardcodes depth:1.
    // singleBranch:false is required because @cloudflare/shell defaults it
    // to true, which would prevent checking out commits not on the default branch.
    await this.gitWorkspace.git.clone({
      url: task.repoUrl,
      noCheckout: true,
      singleBranch: false,
      ...(token ? { token } : {}),
    });
    await this.gitWorkspace.git.checkout({ ref: task.baseCommit });
    await this.gitWorkspace.git.checkout({ branch });

    console.log(`[pr-replay] checked_out base=${task.baseCommit.slice(0, 8)} branch=${branch}`);

    // --- Agent inference ---
    console.log(`[pr-replay] inference_start branch=${branch}`);
    const inferenceStart = Date.now();

    const saveResult = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: task.instructions }],
      },
    ]);

    console.log(
      `[pr-replay] inference_done status=${saveResult.status} duration=${Date.now() - inferenceStart}ms`,
    );

    if (saveResult.status === "skipped") {
      return this.buildFailResult(task, branch, "Inference turn was skipped (concurrent request collision)");
    }

    if (this.turnError) {
      return this.buildFailResult(task, branch, this.turnError);
    }

    const filesChanged = await this.gitWorkspace.getChangedFiles();

    if (filesChanged.length === 0) {
      return this.buildFailResult(task, branch, "Agent made no changes to the repository");
    }

    // --- Verify (before commit so scoring state is preserved even if push fails) ---
    const rewardResult = await this.runVerification(task, filesChanged);

    // --- Commit ---
    let commitSha: string;
    try {
      commitSha = await this.gitWorkspace.commitAndPush({
        branch,
        message: `flarbor: ${task.name}`,
        token,
        gitConfig: {
          authorName: req.authorName ?? "Flarbor Agent",
          authorEmail: req.authorEmail ?? "agent@flarbor.dev",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[pr-replay] commit_push_failed id=${task.id} branch=${branch} error=${msg}`);
      return {
        success: false,
        branch,
        commitSha: "",
        filesChanged,
        error: `Commit/push failed: ${msg}`,
        usage: this.tokenUsage,
        reward: rewardResult,
        metadata: {
          taskId: task.id,
          prNumber: task.prNumber,
          baseCommit: task.baseCommit,
        },
      };
    }

    console.log(
      `[pr-replay] task_complete success=true id=${task.id} branch=${branch} sha=${commitSha}` +
        ` files_changed=${filesChanged.length} reward=${rewardResult.score.toFixed(3)}` +
        ` tokens={in=${this.tokenUsage.inputTokens},out=${this.tokenUsage.outputTokens}}` +
        ` duration=${Date.now() - taskStart}ms`,
    );

    return {
      success: true,
      branch,
      commitSha,
      filesChanged,
      usage: this.tokenUsage,
      reward: rewardResult,
      metadata: {
        taskId: task.id,
        prNumber: task.prNumber,
        baseCommit: task.baseCommit,
      },
    };
  }

  private async runVerification(
    task: PRReplayTask,
    filesChanged: string[],
  ): Promise<RewardResult> {
    try {
      const referenceDiff = REFERENCE_DIFFS[task.patchFile] ?? "";

      const result = await verifyPRReplay({
        task,
        workspace: this.workspace,
        filesChanged,
        success: true,
        referenceDiff,
        // LLM judge uses the same model as the agent for now.
        model: createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-sonnet-4-20250514"),
      });

      return toReward(result);
    } catch (err) {
      console.error(
        `[pr-replay] verification_error: ${err instanceof Error ? err.message : err}`,
      );
      // Return a well-formed error result with a single failed criterion.
      return {
        score: 0,
        rewards: [
          {
            name: "verification",
            score: 0,
            aggregation: "weighted_mean",
            criteria: [
              {
                name: "verification_error",
                score: 0,
                weight: 1,
                error: err instanceof Error ? err.message : String(err),
              },
            ],
          },
        ],
        totalCriteria: 1,
        errors: 1,
      };
    }
  }

  private async buildFailResult(
    task: PRReplayTask,
    branch: string,
    error: string,
  ): Promise<TrialResult> {
    console.error(
      `[pr-replay] task_failed id=${task.id} branch=${branch}` +
        ` tokens={in=${this.tokenUsage.inputTokens},out=${this.tokenUsage.outputTokens}}` +
        ` error=${error}`,
    );

    // Even on failure, run verification to get a score (likely 0).
    const rewardResult = await this.runVerification(task, []);

    return {
      success: false,
      branch,
      commitSha: "",
      filesChanged: [],
      error,
      usage: this.tokenUsage,
      reward: rewardResult,
      metadata: {
        taskId: task.id,
        prNumber: task.prNumber,
        baseCommit: task.baseCommit,
      },
    };
  }

  /**
   * The DO receives the full RunRequest body (including taskId) from the
   * Worker via dispatchTask, which JSON-serializes whatever object it gets.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      try {
        // Tolerate empty or non-JSON bodies so env defaults (TASK_ID, etc.) still apply.
        let body: unknown = {};
        try {
          body = await request.json();
        } catch {
          // Empty body or invalid JSON — fall through to env defaults.
        }
        const req = resolveRunRequest(body, this.env);
        const result = await this.handlePRReplay(req);
        return Response.json(result, { status: result.success ? 200 : 500 });
      } catch (err: unknown) {
        if (err instanceof z.ZodError) {
          console.error(`[pr-replay] validation_error issues=${JSON.stringify(err.issues)}`);
          return Response.json(
            { success: false, error: "Invalid request", details: err.issues },
            { status: 400 },
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pr-replay] unhandled_error error=${message}`);
        return Response.json(
          { success: false, error: message, branch: "", commitSha: "", filesChanged: [] },
          { status: 500 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();

    if (url.pathname === "/tasks" && request.method === "GET") {
      return taskListResponse();
    }

    if (url.pathname === "/run" && request.method === "POST") {
      console.log(`[pr-replay:worker] incoming POST /run`);

      let req: RunRequest;
      try {
        // Tolerate empty or non-JSON bodies so env defaults (TASK_ID, etc.) still apply.
        let body: unknown = {};
        try {
          body = await request.json();
        } catch {
          // Empty body or invalid JSON — fall through to env defaults.
        }
        req = resolveRunRequest(body, env);
      } catch (err: unknown) {
        if (err instanceof z.ZodError) {
          console.error(
            `[pr-replay:worker] validation_error issues=${JSON.stringify(err.issues)}`,
          );
          return Response.json(
            { success: false, error: "Invalid request", details: err.issues },
            { status: 400 },
          );
        }
        throw err;
      }

      const task = getTask(req.taskId);
      if (!task) {
        return Response.json(
          {
            success: false,
            error: `Unknown task ID: "${req.taskId}". Available: ${TASKS.map((t) => t.id).join(", ")}`,
          },
          { status: 400 },
        );
      }

      // Generate branch eagerly so agentNameFor produces a unique DO name
      // per run. Without this, all runs without an explicit branch would
      // hash to the same DO and reuse workspace/session state.
      const branch =
        req.branch ?? `flarbor/${task.id}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

      console.log(
        `[pr-replay:worker] dispatching task=${req.taskId} repo=${task.repoUrl}` +
          ` base=${task.baseCommit.slice(0, 8)} branch=${branch}`,
      );

      // Build a full TaskConfig (required by runTask/dispatchTask) and
      // attach taskId so the DO can look up the PRReplayTask.
      // dispatchTask serialises the entire object as the POST body.
      const dispatchBody = {
        repoUrl: task.repoUrl,
        instructions: task.instructions,
        branch,
        authorName: req.authorName,
        authorEmail: req.authorEmail,
        maxSteps: req.maxSteps,
        taskId: req.taskId,
      };

      const name = agentNameFor(dispatchBody);
      const stub = env.FLARBOR_AGENT.getByName(name);
      const result = await runTask(stub, dispatchBody);

      console.log(
        `[pr-replay:worker] response success=${result.success}` +
          ` duration=${Date.now() - start}ms` +
          (result.error ? ` error=${result.error}` : ""),
      );
      return Response.json(result, { status: result.success ? 200 : 500 });
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

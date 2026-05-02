import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest } from "agents";
import { z } from "zod";
import { FlarborEnvironment, runTask } from "flarbor";
import type { EnvironmentConfig, FlarborEnv, TaskConfig, TrialResult, RewardResult } from "flarbor";
import {
  run as scoreRun,
  reward,
  trialSuccess,
  hasChanges,
  noDeletions,
  diffSize,
  tokenBudget,
  stepBudget,
} from "flarbor-reward";
import type { CriterionContext } from "flarbor-reward";

interface Env extends FlarborEnv {
  FLARBOR_AGENT: DurableObjectNamespace;
  REPO_URL?: string;
  INSTRUCTION?: string;
  BRANCH?: string;
  AUTHOR_NAME?: string;
  AUTHOR_EMAIL?: string;
  MAX_STEPS?: string;
}

const TaskConfigSchema = z.object({
  repoUrl: z.string().url(),
  instructions: z.string().min(1),
  branch: z.string().min(1).optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().email().optional(),
  maxSteps: z.number().int().positive().optional(),
});

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

/** POST body fields take precedence over env var defaults. */
function resolveTaskConfig(body: unknown, env: Env): TaskConfig {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  return TaskConfigSchema.parse({
    repoUrl: raw.repoUrl ?? env.REPO_URL,
    instructions: raw.instructions ?? env.INSTRUCTION,
    branch: raw.branch ?? env.BRANCH,
    authorName: raw.authorName ?? env.AUTHOR_NAME,
    authorEmail: raw.authorEmail ?? env.AUTHOR_EMAIL,
    maxSteps: raw.maxSteps ?? parseMaxSteps(env.MAX_STEPS),
  });
}

export class FlarborAgent extends FlarborEnvironment<Env> {
  getEnvironmentConfig(): EnvironmentConfig {
    return {
      model: createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })("claude-opus-4-6"),

      systemPrompt: [
        "You are a code modification agent. You have access to a cloned git repository in your workspace.",
        "Use the workspace tools (read, write, edit, find, grep, list) to understand the codebase and make the requested changes.",
        "Use the execute tool to run JavaScript code when you need to process multiple files or do complex operations.",
        "Be precise and make only the changes requested. Do not modify files unnecessarily.",
        "When you are done, summarize what you changed and why.",
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
      protectedPaths: [".git/**", ".github/workflows/**"],
    };
  }

  private async scoreTrial(ctx: CriterionContext): Promise<RewardResult> {
    return scoreRun(
      [
        reward({
          name: "correctness",
          criteria: [trialSuccess(3.0), hasChanges(2.0), noDeletions(1.0)],
        }),
        reward({
          name: "precision",
          criteria: [diffSize(10, 1.0)],
        }),
        reward({
          name: "efficiency",
          criteria: [tokenBudget(100_000, 1.0), stepBudget(undefined, 1.0)],
        }),
      ],
      ctx,
    );
  }

  async handleTask(task: TaskConfig): Promise<TrialResult> {
    const taskStart = Date.now();
    this.resetTaskState();
    this.maxSteps = task.maxSteps ?? 30;

    const branch = task.branch ?? `flarbor/${Date.now().toString(36)}`;
    const token = this.env.GITHUB_TOKEN;

    console.log(
      `[code-change] task_start repo=${task.repoUrl} branch=${branch}` +
        ` max_steps=${this.maxSteps} instructions="${task.instructions.slice(0, 80)}"`,
    );

    await this.gitWorkspace.clone(task.repoUrl, token);
    await this.gitWorkspace.createBranch(branch);

    console.log(`[code-change] inference_start branch=${branch}`);
    const inferenceStart = Date.now();

    const saveResult = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: task.instructions }],
      },
    ]);

    console.log(
      `[code-change] inference_done status=${saveResult.status} duration=${Date.now() - inferenceStart}ms`,
    );

    if (saveResult.status === "skipped") {
      return this.buildFailResult(
        branch,
        "Inference turn was skipped (concurrent request collision)",
      );
    }

    if (this.turnError) {
      return this.buildFailResult(branch, this.turnError);
    }

    const filesChanged = await this.gitWorkspace.getChangedFiles();

    if (filesChanged.length === 0) {
      return this.buildFailResult(branch, "Agent made no changes to the repository");
    }

    const commitSha = await this.gitWorkspace.commitAndPush({
      branch,
      message: `flarbor: ${task.instructions.slice(0, 72)}`,
      token,
      gitConfig: {
        authorName: task.authorName ?? "Flarbor Agent",
        authorEmail: task.authorEmail ?? "agent@flarbor.dev",
      },
    });

    const rewardResult = await this.scoreTrial({
      workspace: this.workspace,
      filesChanged,
      success: true,
      usage: this.tokenUsage,
      steps: this.stepCount,
      maxSteps: this.maxSteps,
    });

    console.log(
      `[code-change] task_complete success=true branch=${branch} sha=${commitSha}` +
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
    };
  }

  private async buildFailResult(branch: string, error: string): Promise<TrialResult> {
    console.error(
      `[code-change] task_failed branch=${branch}` +
        ` tokens={in=${this.tokenUsage.inputTokens},out=${this.tokenUsage.outputTokens}}` +
        ` error=${error}`,
    );

    const rewardResult = await this.scoreTrial({
      workspace: this.workspace,
      filesChanged: [],
      success: false,
      usage: this.tokenUsage,
      error,
      steps: this.stepCount,
      maxSteps: this.maxSteps,
    });

    return {
      success: false,
      branch,
      commitSha: "",
      filesChanged: [],
      error,
      usage: this.tokenUsage,
      reward: rewardResult,
    };
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      try {
        const task = resolveTaskConfig(await request.json(), this.env);
        const result = await this.handleTask(task);
        return Response.json(result, { status: result.success ? 200 : 500 });
      } catch (err: unknown) {
        if (err instanceof z.ZodError) {
          console.error(`[code-change] validation_error issues=${JSON.stringify(err.issues)}`);
          return Response.json(
            { success: false, error: "Invalid task config", details: err.issues },
            { status: 400 },
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[code-change] unhandled_error error=${message}`);
        const result = await this.buildFailResult("", message);
        return Response.json(result, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();

    if (url.pathname === "/run" && request.method === "POST") {
      console.log(`[code-change:worker] incoming POST /run`);

      let task: TaskConfig;
      try {
        task = resolveTaskConfig(await request.clone().json(), env);
      } catch (err: unknown) {
        if (err instanceof z.ZodError) {
          console.error(
            `[code-change:worker] validation_error issues=${JSON.stringify(err.issues)}`,
          );
          return Response.json(
            { success: false, error: "Invalid task config", details: err.issues },
            { status: 400 },
          );
        }
        throw err;
      }

      console.log(
        `[code-change:worker] dispatching repo=${task.repoUrl} branch=${task.branch ?? "(auto)"}`,
      );
      const name = `${task.repoUrl}:${task.branch ?? "default"}`;
      const stub = env.FLARBOR_AGENT.getByName(name);
      const result = await runTask(stub, task);
      console.log(
        `[code-change:worker] response success=${result.success}` +
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

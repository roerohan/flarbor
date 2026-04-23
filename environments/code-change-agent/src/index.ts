import { createAnthropic } from "@ai-sdk/anthropic";
import { routeAgentRequest } from "agents";
import { FlarborEnvironment, runTask } from "flarbor";
import type {
  EnvironmentConfig,
  FlarborEnv,
  TaskConfig,
  TrialResult,
} from "flarbor";

interface Env extends FlarborEnv {
  FLARBOR_AGENT: DurableObjectNamespace;
}

/**
 * CodeChangeAgent — clones a repo, makes LLM-driven changes, pushes.
 *
 * FlarborEnvironment provides the Think infrastructure (lifecycle hooks,
 * token tracking, error capture, session/tools wiring, chat recovery).
 * This class provides everything domain-specific: model, prompt, session
 * context, safety rules, and the task execution workflow.
 */
export class FlarborAgent extends FlarborEnvironment<Env> {
  getEnvironmentConfig(): EnvironmentConfig {
    return {
      model: createAnthropic({
        apiKey: this.env.ANTHROPIC_API_KEY,
      })("claude-opus-4-6"),

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
            description:
              "Your current plan for completing the task. Update this as you work through the steps.",
            maxTokens: 1000,
          })
          .withContext("memory", {
            description:
              "Important facts learned about this codebase during the current task. File locations, patterns, conventions.",
            maxTokens: 2000,
          })
          .withCachedPrompt(),

      maxSteps: 30,
      protectedPaths: [".git/**", ".github/workflows/**"],
    };
  }

  /**
   * Execute a code change task end-to-end:
   * 1. Clone the repository
   * 2. Create a new branch
   * 3. Run the Think agentic loop with the instructions
   * 4. Validate the result
   * 5. Commit changes and push
   */
  async handleTask(task: TaskConfig): Promise<TrialResult> {
    console.log("[code-change-agent] handleTask started:", JSON.stringify({
      repoUrl: task.repoUrl,
      branch: task.branch,
      instructionsLength: task.instructions.length,
    }));

    this.resetTaskState();

    // Set maxSteps from task config or environment default
    this.maxSteps = task.maxSteps ?? 30;

    const branch = task.branch ?? `flarbor/${Date.now().toString(36)}`;
    const token = this.env.GITHUB_TOKEN;

    // 1. Clone the repository into the workspace
    console.log("[code-change-agent] Step 1: Cloning repository...");
    await this.gitWorkspace.clone(task.repoUrl, token);
    console.log("[code-change-agent] Step 1: Clone complete");

    // 2. Create the branch before the agentic loop
    console.log("[code-change-agent] Step 2: Creating branch:", branch);
    await this.gitWorkspace.createBranch(branch);
    console.log("[code-change-agent] Step 2: Branch created");

    // 3. Run the Think agentic loop
    console.log("[code-change-agent] Step 3: Running Think agentic loop...");
    const saveResult = await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: task.instructions }],
      },
    ]);

    console.log("[code-change-agent] Step 3: saveMessages result:", saveResult.status);

    // Check if the turn was actually processed
    if (saveResult.status === "skipped") {
      return {
        success: false,
        branch,
        commitSha: "",
        filesChanged: [],
        error: "Inference turn was skipped (concurrent request collision)",
        usage: this.tokenUsage,
      };
    }

    // Check if the inference loop errored
    if (this.turnError) {
      return {
        success: false,
        branch,
        commitSha: "",
        filesChanged: [],
        error: this.turnError,
        usage: this.tokenUsage,
      };
    }

    // 4. Get changed files
    console.log("[code-change-agent] Step 4: Getting changed files...");
    const filesChanged = await this.gitWorkspace.getChangedFiles();
    console.log("[code-change-agent] Step 4: Changed files:", filesChanged);

    if (filesChanged.length === 0) {
      return {
        success: false,
        branch,
        commitSha: "",
        filesChanged: [],
        error: "Agent made no changes to the repository",
        usage: this.tokenUsage,
      };
    }

    // 5. Commit and push
    console.log("[code-change-agent] Step 5: Committing and pushing...");
    const commitSha = await this.gitWorkspace.commitAndPush({
      branch,
      message: `flarbor: ${task.instructions.slice(0, 72)}`,
      token,
      gitConfig: {
        authorName: task.authorName ?? "Flarbor Agent",
        authorEmail: task.authorEmail ?? "agent@flarbor.dev",
      },
    });

    console.log("[code-change-agent] Step 5: Push complete, commitSha:", commitSha);

    return {
      success: true,
      branch,
      commitSha,
      filesChanged,
      usage: this.tokenUsage,
    };
  }

  /**
   * Handle non-WebSocket requests. Called by PartyServer's fetch() AFTER
   * name hydration and initialization are complete.
   *
   * POST /run → execute the code change workflow
   * Everything else → 404
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      try {
        const task = (await request.json()) as TaskConfig;
        const result = await this.handleTask(task);
        return Response.json(result, {
          status: result.success ? 200 : 500,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        const stack =
          err instanceof Error ? err.stack : undefined;
        console.error("[code-change-agent] handleTask error:", message);
        if (stack) console.error("[code-change-agent] stack:", stack);
        const result: TrialResult = {
          success: false,
          branch: "",
          commitSha: "",
          filesChanged: [],
          error: message,
        };
        return Response.json(result, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}

/**
 * Worker entrypoint. Routes requests to the FlarborAgent Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run" && request.method === "POST") {
      const body = (await request.clone().json()) as TaskConfig;
      const name = `${body.repoUrl}:${body.branch ?? "default"}`;
      const stub = env.FLARBOR_AGENT.getByName(name);
      const result = await runTask(stub, body);
      return Response.json(result, {
        status: result.success ? 200 : 500,
      });
    }

    // For WebSocket/chat connections, use the agents SDK router
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
